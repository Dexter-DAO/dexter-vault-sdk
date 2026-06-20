// tests/e2e/signer-webauthn.e2e.test.ts
//
// REAL on-chain end-to-end test for the canonical browser passkey signer.
//
// This is NOT a stubbed unit test. The previous unit tests injected CANNED
// assertion bytes (`new Uint8Array(64).fill(9)`) and only asserted "the call
// happened" — that hid a hashing bug, because canned bytes never pass a real
// cryptographic verifier. This test closes that gap end to end:
//
//   1. A REAL software P-256 WebAuthn authenticator (real `p256.sign`, real
//      clientDataJSON containing the base64url challenge, real
//      authenticatorData) is wrapped in an `AssertionLike` adapter and injected
//      into the SDK signer via the `__assertion` seam. NO canned bytes.
//
//   2. The SDK's CANONICAL method `signer.signOperation(operationMessage)` is
//      driven. The signer hashes sha256(op) internally, mints a server
//      challenge bound to that hash (wired to return the opHash AS the
//      challenge — the real dexter-api + webauthn.rs law), and the injected
//      authenticator asserts over that server challenge with a real signature.
//
//   3. The produced clientDataJSON is parsed and the money-path invariant is
//      asserted from the ACTUAL bytes the signer emitted:
//          JSON.parse(clientDataJSON).challenge === base64url(sha256(op))
//      A hashing/assembly bug breaks this.
//
//   4. The signer's REAL output bytes (signature, clientDataJSON,
//      authenticatorData) are reassembled into the precompile message
//      (authenticatorData || sha256(clientDataJSON)) and submitted to the
//      SIMD-0075 secp256r1 sigverify precompile on a LOCAL VALIDATOR. The
//      precompile is a NATIVE runtime program and IS the on-chain WebAuthn
//      signature law (programs/dexter-vault/src/verify/webauthn.rs delegates
//      ECDSA verification to it). A tx whose only instruction is the precompile
//      LANDS iff the (signature, message, pubkey) triple is cryptographically
//      valid and REVERTS otherwise. The tx landing == the real verifier
//      accepting the signer's bytes.
//
//   5. A NEGATIVE assertion corrupts one signature byte and proves the same
//      precompile REVERTS — demonstrating the test CAN fail on a bad signature
//      (i.e. it would catch a hashing bug, not rubber-stamp).
//
// SELF-SKIPS unless RUN_WEBAUTHN_E2E=1 (needs a running solana-test-validator),
// so the default `vitest run` stays green on a validator-less box.

import { describe, it, expect, beforeAll } from 'vitest';
import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha256';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';

import { DexterApiBrowserPasskeySigner } from '../../src/signers/browser/dexterApiSigner.js';
import {
  buildSecp256r1VerifyInstruction,
  buildPrecompileMessage,
} from '../../src/precompile/secp256r1.js';

const RUN = process.env.RUN_WEBAUTHN_E2E === '1';
const run = RUN ? describe : describe.skip;

const RPC_URL = process.env.WEBAUTHN_E2E_RPC ?? 'http://127.0.0.1:8899';
const RP_ID = 'dexter.cash';

// ── base64url (matches dexter-vault/tests/helpers/secp256r1.ts) ─────────────
function base64urlEncode(input: Uint8Array): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// ── REAL software WebAuthn authenticator ────────────────────────────────────
//
// Wraps a software P-256 keypair behind the SDK's `AssertionLike` contract.
// `assertOver(serverChallenge)` performs a REAL WebAuthn ceremony:
//   - builds a real clientDataJSON whose `challenge` is base64url(serverChallenge)
//   - builds a real authenticatorData (rpIdHash || flags || signCount)
//   - signs sha256(authenticatorData || sha256(clientDataJSON)) with real p256
// and returns the real bytes. This is the exact shape a browser authenticator
// produces; nothing is canned.
class SoftwareWebAuthnAuthenticator {
  readonly credentialId: Uint8Array;
  private readonly privateKey: Uint8Array;
  readonly publicKey: Uint8Array; // 33-byte SEC1 compressed
  private signCount = 1;

  constructor(credentialId: Uint8Array) {
    this.credentialId = credentialId;
    this.privateKey = p256.utils.randomPrivateKey();
    this.publicKey = p256.getPublicKey(this.privateKey, true);
  }

  private buildClientDataJSON(challengeBytes: Uint8Array): Uint8Array {
    const obj = {
      type: 'webauthn.get',
      challenge: base64urlEncode(challengeBytes),
      origin: `https://${RP_ID}`,
      crossOrigin: false,
    };
    return new TextEncoder().encode(JSON.stringify(obj));
  }

  private buildAuthenticatorData(): Uint8Array {
    const rpIdHash = sha256(new TextEncoder().encode(RP_ID));
    const out = new Uint8Array(32 + 1 + 4);
    out.set(rpIdHash, 0);
    out[32] = 0x05; // UP | UV
    new DataView(out.buffer).setUint32(33, this.signCount, false);
    return out;
  }

  async assertOver(challenge: Uint8Array): Promise<{
    signature: Uint8Array;
    clientDataJSON: Uint8Array;
    authenticatorData: Uint8Array;
  }> {
    const clientDataJSON = this.buildClientDataJSON(challenge);
    const authenticatorData = this.buildAuthenticatorData();

    const clientDataHash = sha256(clientDataJSON);
    const precompileMessage = new Uint8Array(authenticatorData.length + 32);
    precompileMessage.set(authenticatorData, 0);
    precompileMessage.set(clientDataHash, authenticatorData.length);

    // The precompile verifies the ECDSA signature over sha256(precompileMessage).
    const messageHash = sha256(precompileMessage);
    const sig = p256.sign(messageHash, this.privateKey, { lowS: true });
    const signature = sig.toCompactRawBytes(); // 64-byte r||s

    return { signature, clientDataJSON, authenticatorData };
  }
}

// ── operation message builder (mirrors the Rust set_swig handler) ───────────
function setSwigMessage(swigAddress: PublicKey): Uint8Array {
  const tag = new TextEncoder().encode('set_swig');
  const buf = new Uint8Array(tag.length + 32);
  buf.set(tag, 0);
  buf.set(swigAddress.toBytes(), tag.length);
  return buf;
}

const SECP256R1_PROGRAM_ID = new PublicKey(
  'Secp256r1SigVerify1111111111111111111111111',
);

async function rpcUp(conn: Connection): Promise<boolean> {
  try {
    await conn.getLatestBlockhash('confirmed');
    return true;
  } catch {
    return false;
  }
}

async function landTx(
  conn: Connection,
  payer: Keypair,
  ix: TransactionInstruction,
): Promise<string> {
  const { blockhash, lastValidBlockHeight } =
    await conn.getLatestBlockhash('confirmed');
  const tx = new Transaction();
  tx.recentBlockhash = blockhash;
  tx.feePayer = payer.publicKey;
  tx.add(ix);
  tx.sign(payer);
  const sig = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  });
  const res = await conn.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    'confirmed',
  );
  if (res.value.err) {
    throw new Error(`tx ${sig} failed: ${JSON.stringify(res.value.err)}`);
  }
  return sig;
}

run('signer → real secp256r1 precompile (on-chain WebAuthn law)', () => {
  let conn: Connection;
  let payer: Keypair;

  beforeAll(async () => {
    conn = new Connection(RPC_URL, 'confirmed');

    // Wait for the validator RPC to be up.
    const deadline = Date.now() + 60_000;
    let healthy = false;
    while (Date.now() < deadline) {
      if (await rpcUp(conn)) {
        healthy = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!healthy) {
      throw new Error(
        `validator RPC at ${RPC_URL} never came up — start solana-test-validator first`,
      );
    }

    // Fresh, airdrop-funded fee payer.
    payer = Keypair.generate();
    const air = await conn.requestAirdrop(payer.publicKey, 2_000_000_000);
    const bh = await conn.getLatestBlockhash('confirmed');
    await conn.confirmTransaction(
      { signature: air, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight },
      'confirmed',
    );
  }, 90_000);

  it('SMOKE: the secp256r1 precompile is native on a bare validator', async () => {
    // A known keypair signs a known message; a valid precompile ix MUST land.
    const sk = p256.utils.randomPrivateKey();
    const pk = p256.getPublicKey(sk, true);
    const message = new TextEncoder().encode('precompile-smoke-check');
    const sig = p256.sign(sha256(message), sk, { lowS: true }).toCompactRawBytes();

    const ix = buildSecp256r1VerifyInstruction(pk, sig, message);
    expect(ix.programId.equals(SECP256R1_PROGRAM_ID)).toBe(true);

    const txSig = await landTx(conn, payer, ix);
    expect(typeof txSig).toBe('string');
  }, 60_000);

  it('signer.signOperation bytes PASS the real precompile + challenge === base64url(sha256(op))', async () => {
    // ── REAL software authenticator (no canned bytes) ──
    const credentialId = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]);
    const authenticator = new SoftwareWebAuthnAuthenticator(credentialId);

    // The vault stores the 33-byte SEC1 compressed authority pubkey; the signer
    // exposes it, and the precompile verifies against it.
    const publicKey = authenticator.publicKey;

    // Auth-path server policy: the server uses sha256(op) AS the WebAuthn
    // challenge (the dexter-api + on-chain webauthn.rs law).
    const policy = {
      issueChallenge: async ({ operationHash }: { operationHash: Uint8Array }) =>
        operationHash,
      verify: async () => undefined,
    };

    const signer = new DexterApiBrowserPasskeySigner({
      credentialId,
      publicKey,
      policy,
      __assertion: authenticator,
    });

    // ── Build a REAL operation message (set_swig shape, 8 + 32 bytes) ──
    const swigAddress = Keypair.generate().publicKey;
    const opMessage = setSwigMessage(swigAddress);

    // ── Drive the canonical signer method ──
    const out = await signer.signOperation(opMessage);
    expect(out.signature).toHaveLength(64);

    // ── INVARIANT: challenge in the PRODUCED clientDataJSON === base64url(sha256(op)) ──
    const clientData = JSON.parse(new TextDecoder().decode(out.clientDataJSON));
    expect(clientData.type).toBe('webauthn.get');
    const expectedChallenge = base64urlEncode(sha256(opMessage));
    expect(clientData.challenge).toBe(expectedChallenge);

    // ── Reassemble precompile message from the signer's REAL output bytes ──
    const precompileMessage = await buildPrecompileMessage(
      out.clientDataJSON,
      out.authenticatorData,
    );

    // ── Submit to the REAL on-chain secp256r1 precompile; lands iff valid ──
    const verifyIx = buildSecp256r1VerifyInstruction(
      signer.publicKey,
      out.signature,
      precompileMessage,
    );
    const txSig = await landTx(conn, payer, verifyIx);
    expect(typeof txSig).toBe('string');

    // ── NEGATIVE: corrupt one signature byte → the precompile MUST reject ──
    const badSig = Uint8Array.from(out.signature);
    badSig[0] = badSig[0]! ^ 0x01;
    const badIx = buildSecp256r1VerifyInstruction(
      signer.publicKey,
      badSig,
      precompileMessage,
    );
    let rejected = false;
    try {
      await landTx(conn, payer, badIx);
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  }, 90_000);
});
