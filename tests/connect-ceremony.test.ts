/**
 * connectTab — browser ceremony tests (C2).
 *
 * The make-or-break is the ROUND-TRIP: connectTab's ConnectProof must be
 * exactly what verifyConnectProof (C1) accepts. Real P-256 verification is the
 * chain's job (simulate), so the round-trip is proven at the ASSEMBLY level
 * with an injected `err: null` simulate — a byte-shape or challenge-contract
 * mismatch would surface as a throw or an assembly error here.
 *
 * The linchpin assertion: the bytes connectTab passes to
 * navigator.credentials.get's publicKey.challenge MUST equal
 *   sha256("siwx_login" || decodeChallengeTo32Bytes(challenge))
 * so the browser writes base64url(thoseBytes) into clientDataJSON.challenge —
 * exactly what prove_passkey reconstructs and the precompile signs over.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { connectTab } from '../src/connect/ceremony.js';
import {
  verifyConnectProof,
  decodeChallengeTo32Bytes,
} from '../src/connect/verify.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

const CRED_ID = new Uint8Array(16).fill(0xab);
// 33-byte compressed P-256 pubkey: 0x02 prefix + 32 bytes.
const PASSKEY_PUBKEY = (() => {
  const k = new Uint8Array(33).fill(0x07);
  k[0] = 0x02;
  return k;
})();
// A real on-chain vault PDA (valid base58 / on-curve-agnostic — any valid
// PublicKey string works; this is the System Program id, a known-valid base58).
const VAULT = '11111111111111111111111111111111';
// Canonical issuer form: base64url(32 random bytes), unpadded.
const CHALLENGE = Buffer.from(new Uint8Array(32).fill(0x5a)).toString('base64url');

/** The exact bytes the ceremony MUST sign over (sha256 of the op-message). */
function expectedSignedDigest(challenge: string): Uint8Array {
  const challengeBytes = decodeChallengeTo32Bytes(challenge);
  const opMessage = Buffer.concat([
    Buffer.from('siwx_login', 'utf8'),
    Buffer.from(challengeBytes),
  ]);
  return new Uint8Array(createHash('sha256').update(opMessage).digest());
}

/** base64url(x) — what the browser writes into clientDataJSON.challenge. */
function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

/**
 * Install a fake navigator whose credentials.get records the challenge it
 * received and returns a deterministic assertion. The clientDataJSON echoes the
 * received challenge as base64url, mirroring real WebAuthn behavior.
 */
function installFakeNavigatorRecording(): {
  receivedChallenge: () => Uint8Array;
  clientDataJSON: () => Uint8Array;
} {
  let captured: Uint8Array = new Uint8Array(0);
  let cdj: Uint8Array = new Uint8Array(0);

  const getImpl = async (opts: CredentialRequestOptions) => {
    const pk = (opts as { publicKey: PublicKeyCredentialRequestOptions }).publicKey;
    captured = new Uint8Array(pk.challenge as ArrayBuffer);
    // Real browsers write base64url(challengeBytes) into clientDataJSON.challenge.
    cdj = new TextEncoder().encode(
      JSON.stringify({
        type: 'webauthn.get',
        challenge: base64url(captured),
        origin: 'https://relying.app',
      }),
    );
    // Minimal valid DER signature (SEQUENCE { INTEGER r(32), INTEGER s(32) }).
    const der = encodeDer(new Uint8Array(32).fill(0x11), new Uint8Array(32).fill(0x22));
    const authData = new Uint8Array(37).fill(0x99);
    return {
      type: 'public-key',
      response: {
        signature: der.buffer,
        clientDataJSON: cdj.buffer,
        authenticatorData: authData.buffer,
      },
    } as unknown as Credential;
  };

  Object.defineProperty(globalThis, 'navigator', {
    value: { credentials: { get: getImpl } },
    configurable: true,
    writable: true,
  });

  return {
    receivedChallenge: () => captured,
    clientDataJSON: () => cdj,
  };
}

function encodeDer(r: Uint8Array, s: Uint8Array): Uint8Array {
  const seqLen = 2 + r.length + 2 + s.length;
  const out = new Uint8Array(2 + seqLen);
  let i = 0;
  out[i++] = 0x30;
  out[i++] = seqLen;
  out[i++] = 0x02;
  out[i++] = r.length;
  out.set(r, i);
  i += r.length;
  out[i++] = 0x02;
  out[i++] = s.length;
  out.set(s, i);
  return out;
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('connectTab', () => {
  const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'navigator',
  );

  afterEach(() => {
    if (originalNavigatorDescriptor) {
      Object.defineProperty(globalThis, 'navigator', originalNavigatorDescriptor);
    } else {
      delete (globalThis as { navigator?: unknown }).navigator;
    }
    vi.restoreAllMocks();
  });

  it('Test 1 — ceremony shape + linchpin challenge derivation', async () => {
    const nav = installFakeNavigatorRecording();

    const proof = await connectTab({
      challenge: CHALLENGE,
      vault: VAULT,
      passkeyPubkey: PASSKEY_PUBKEY,
      credentialId: CRED_ID,
    });

    // Shape: vault + pubkey echoed, sig 64 bytes, non-empty cdata/authdata.
    expect(proof.vault).toBe(VAULT);
    expect([...proof.passkeyPubkey]).toEqual([...PASSKEY_PUBKEY]);
    expect(proof.signature.length).toBe(64);
    expect(proof.clientDataJSON.length).toBeGreaterThan(0);
    expect(proof.authenticatorData.length).toBeGreaterThan(0);

    // LINCHPIN: the bytes sent to navigator.credentials.get's publicKey.challenge
    // must equal sha256("siwx_login" || decodeChallengeTo32Bytes(challenge)).
    const expected = expectedSignedDigest(CHALLENGE);
    expect([...nav.receivedChallenge()]).toEqual([...expected]);
    // And it must be a 32-byte digest, not the raw 32-byte challenge.
    expect(nav.receivedChallenge().length).toBe(32);
    expect([...nav.receivedChallenge()]).not.toEqual([
      ...decodeChallengeTo32Bytes(CHALLENGE),
    ]);

    // CONTRACT proof: clientDataJSON.challenge == base64url(sha256(opMessage)).
    const cdj = JSON.parse(new TextDecoder().decode(proof.clientDataJSON));
    expect(cdj.challenge).toBe(base64url(expected));
  });

  it('Test 2 — ROUND-TRIP: connectTab output verifies via verifyConnectProof', async () => {
    installFakeNavigatorRecording();

    const proof = await connectTab({
      challenge: CHALLENGE,
      vault: VAULT,
      passkeyPubkey: PASSKEY_PUBKEY,
      credentialId: CRED_ID,
    });

    // Injected simulate stands in for the chain returning err: null (accept).
    // The point is ASSEMBLY agreement: feeding connectTab's ConnectProof into
    // the verifier must not throw building the [secp256r1_verify, prove_passkey]
    // tx — byte shapes + the challenge contract line up.
    const fakeSimulate = vi.fn(async () => ({ value: { err: null } }));
    const connectionStub = {} as never; // never hit — simulate is injected.

    const result = await verifyConnectProof({
      connection: connectionStub,
      challenge: CHALLENGE, // SAME string both sides used.
      proof,
      simulate: fakeSimulate,
    });

    expect(result.ok).toBe(true);
    expect(result.vault?.toBase58()).toBe(VAULT);
    expect(fakeSimulate).toHaveBeenCalledOnce();

    // The assembled tx the verifier built from connectTab's output: a real
    // 2-instruction tx (secp256r1_verify + prove_passkey), no assembly throw.
    const tx = fakeSimulate.mock.calls[0][0] as { instructions: unknown[] };
    expect(tx.instructions.length).toBe(2);
  });

  it('round-trip surfaces a chain reject (err != null) as ok:false', async () => {
    installFakeNavigatorRecording();
    const proof = await connectTab({
      challenge: CHALLENGE,
      vault: VAULT,
      passkeyPubkey: PASSKEY_PUBKEY,
      credentialId: CRED_ID,
    });
    const rejectSimulate = vi.fn(async () => ({
      value: { err: { InstructionError: [0, 'Custom'] } },
    }));
    const result = await verifyConnectProof({
      connection: {} as never,
      challenge: CHALLENGE,
      proof,
      simulate: rejectSimulate,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/simulation rejected/);
  });
});
