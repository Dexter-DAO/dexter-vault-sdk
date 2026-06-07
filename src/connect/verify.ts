/**
 * verifyConnectProof — the relying-app VERIFIER for "Connect a Tab" step 1.
 *
 * A third-party app uses this to confirm a user controls a named Dexter vault.
 * It reconstructs the read-only two-instruction proof transaction
 *   [secp256r1_verify, prove_passkey]
 * from the proof + the challenge it issued + the vault's passkey pubkey, and
 * simulates it against the caller-supplied Connection (Helius mainnet) via the
 * legacy `Transaction` simulate overload — which does NOT verify signatures, so
 * the placeholder blockhash and formal feePayer are never checked.
 * `err === null` → the holder controls the vault.
 *   (`connection.simulateTransaction(tx, undefined, false)`: signature is
 *    `(transaction, signers?, includeAccounts?)`; the third arg is
 *    `includeAccounts`, set false. There is no `sigVerify` param on this
 *    overload — `sigVerify` exists only on the VersionedTransaction config.)
 *
 * This is THE canonical method documented in provePasskey.ts: a verifier treats
 * a passing simulate of [secp256r1_verify, prove_passkey] (err === null) as
 * proof of control.
 * It reuses the exact on-chain P-256 semantics rather than re-implementing
 * verification — a forged/wrong-key/wrong-challenge proof makes the on-chain
 * precompile (or prove_passkey's op-message check) reject, and simulate
 * returns a non-null err. The reject path is genuinely simulate-driven; it is
 * NOT a bypassable string compare.
 *
 * The `simulate` step is injectable with a real default (the same
 * injectable-default-real pattern ./tab and ./factoring use for assembleSignV2
 * / readPriorSpent) so the assembly + decision logic is unit-testable offline,
 * while production hits the real chain.
 */
import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import { createHash } from 'node:crypto';
import { buildProvePasskeyInstruction } from '../instructions/provePasskey.js';
import {
  buildSecp256r1VerifyInstruction,
  buildPrecompileMessage,
} from '../precompile/secp256r1.js';

export interface ConnectProof {
  /** 33-byte compressed P-256 passkey pubkey bound to the vault. */
  passkeyPubkey: Uint8Array;
  /** base58 vault PDA the proof claims control of. */
  vault: string;
  /** WebAuthn ceremony outputs (from WebAuthnAssertionResult). */
  clientDataJSON: Uint8Array;
  authenticatorData: Uint8Array;
  /** 64-byte compact lowS r||s P-256 signature. */
  signature: Uint8Array;
}

export interface ConnectVerifyResult {
  ok: boolean;
  vault?: PublicKey;
  reason?: string;
}

/** Injectable simulate fn — defaults to the real connection.simulateTransaction.
 *  Matches the on-chain verifier method documented in provePasskey.ts.
 *
 *  The return shape is intentionally MINIMAL: only `value.err` is consumed by
 *  the decision path. The real `simulateTransaction` response is richer —
 *  `{ context, value: { err, logs, accounts, unitsConsumed, ... } }`. A future
 *  maintainer wanting richer `reason` diagnostics can read `value.logs` (it is
 *  present on the real response and on the optional `logs?` below). Keeping the
 *  type narrow also keeps the tests' fake simulate trivial. */
export type SimulateFn = (
  tx: Transaction,
) => Promise<{ value: { err: unknown; logs?: string[] | null } }>;

/**
 * CHALLENGE-ENCODING CONTRACT (C2 — the ceremony — MUST match this):
 *
 * The on-chain prove_passkey takes a 32-byte `challenge` (the SIWX nonce/digest);
 * its op-message is "siwx_login" || challenge, and the WebAuthn
 * clientDataJSON.challenge field must base64url-decode to
 * sha256("siwx_login" || challenge).
 *
 * The op-message is exactly utf8("siwx_login") concatenated DIRECTLY with the
 * 32 challenge bytes — no separator, no length prefix, no padding between them
 * (it is rebuilt on-chain by plain byte concatenation; see provePasskey.ts).
 *
 * The relying-app `challenge` STRING that this verifier receives maps to those
 * 32 bytes by this rule:
 *   - if it base64url-decodes to EXACTLY 32 bytes, those bytes ARE the challenge;
 *   - otherwise, sha256(utf8(challenge)) → 32 bytes.
 * The base64url form is accepted with OR without `=` padding; the canonical
 * issuer form is unpadded `base64url(random 32 bytes)`.
 *
 * So a relying app SHOULD issue `base64url(random 32 bytes)` (the canonical,
 * zero-ambiguity form). The fallback (sha256 of an arbitrary string) keeps any
 * other issuer deterministic. C2 produces the matching ceremony challenge:
 *   clientDataJSON.challenge = base64url(sha256("siwx_login" || challengeBytes)).
 */
export function decodeChallengeTo32Bytes(challenge: string): Uint8Array {
  const decoded = tryBase64urlDecode(challenge);
  if (decoded && decoded.length === 32) return decoded;
  return new Uint8Array(createHash('sha256').update(challenge, 'utf8').digest());
}

function tryBase64urlDecode(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9\-_]+={0,2}$/.test(s)) return null;
  try {
    return new Uint8Array(Buffer.from(s, 'base64url'));
  } catch {
    return null;
  }
}

export async function verifyConnectProof(args: {
  connection: Connection;
  /** The challenge the relying app issued (raw string; the SAME one C2 signed). */
  challenge: string;
  proof: ConnectProof;
  /** Default: real connection.simulateTransaction (injectable for tests). */
  simulate?: SimulateFn;
}): Promise<ConnectVerifyResult> {
  const { connection, challenge, proof } = args;
  try {
    // 1. Relying-app challenge string → the 32-byte on-chain challenge.
    const challengeBytes = decodeChallengeTo32Bytes(challenge);

    // Decode the vault first so a bad base58 fails fast (no simulate).
    const vaultPda = new PublicKey(proof.vault);

    // 2. Precompile message = authenticatorData || SHA-256(clientDataJSON).
    const precompileMessage = await buildPrecompileMessage(
      proof.clientDataJSON,
      proof.authenticatorData,
    );

    // 3. The two instructions. Builders enforce 33-byte pubkey / 64-byte sig /
    //    32-byte challenge and throw on length mismatch → caught below.
    const ix0 = buildSecp256r1VerifyInstruction(
      proof.passkeyPubkey,
      proof.signature,
      precompileMessage,
    );
    const ix1 = buildProvePasskeyInstruction({
      vaultPda,
      challenge: challengeBytes,
      clientDataJSON: proof.clientDataJSON,
      authenticatorData: proof.authenticatorData,
    });

    // 4. Assemble [secp256r1_verify, prove_passkey]. The legacy Transaction
    //    simulate overload needs a feePayer + recentBlockhash set, but it does
    //    NOT verify signatures — so neither is ever checked. Both accounts are
    //    read-only/non-signer, so the feePayer is purely formal (use the vault
    //    pubkey) and the blockhash is a placeholder that goes unvalidated.
    //    (simulateTransaction(tx, undefined, false): the third arg is
    //    includeAccounts=false; there is no sigVerify param on this overload.)
    const tx = new Transaction();
    tx.add(ix0, ix1);
    tx.feePayer = vaultPda;
    tx.recentBlockhash = PublicKey.default.toBase58();

    // 5. Injectable-default-real simulate.
    const simulate: SimulateFn =
      args.simulate ??
      ((t) =>
        connection.simulateTransaction(t, undefined, false) as Promise<{
          value: { err: unknown };
        }>);

    // 6. Decide on the on-chain result.
    const res = await simulate(tx);
    const err = res?.value?.err ?? null;
    if (err === null) {
      return { ok: true, vault: vaultPda };
    }
    return { ok: false, reason: `simulation rejected: ${stringifyErr(err)}` };
  } catch (e) {
    // A malformed proof (bad pubkey length, bad base58, bad signature length)
    // returns a clean failure, NOT a throw.
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

function stringifyErr(err: unknown): string {
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
