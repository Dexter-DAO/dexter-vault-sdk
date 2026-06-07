/**
 * connectTab — the browser-side ceremony for "Connect a Tab" step 1 (auth).
 *
 * Runs the WebAuthn passkey assertion and returns a `ConnectProof` that the C1
 * verifier (`verifyConnectProof`) accepts. connectTab + verifyConnectProof must
 * agree byte-for-byte on the challenge contract — the round-trip test is the
 * proof they do.
 *
 * THE CHALLENGE CONTRACT (must match verify.ts / provePasskey.ts / the IDL):
 *   - The relying-app `challenge` STRING maps to 32 bytes via the SAME
 *     `decodeChallengeTo32Bytes` the verifier uses.
 *   - The on-chain prove_passkey op-message is utf8("siwx_login") concatenated
 *     DIRECTLY with those 32 challenge bytes (no separator, no length prefix).
 *   - The WebAuthn `clientDataJSON.challenge` field must equal
 *     base64url(sha256("siwx_login" || challengeBytes)).
 *
 * Since `WebAuthnAssertion.assertOver(X)` causes the browser to write
 * base64url(X) into clientDataJSON.challenge, the bytes we pass to assertOver
 * are sha256("siwx_login" || challengeBytes) — the 32-byte digest, NOT the raw
 * challenge. Then clientDataJSON.challenge == base64url(sha256(opMessage)),
 * exactly what prove_passkey reconstructs and the precompile signature is over.
 *
 * Framework-agnostic: a plain browser function. The C3 button is documented as
 * a snippet, not a shipped React component (React is not a dependency).
 */

import { WebAuthnAssertion } from '../signers/browser/index.js';
import { decodeChallengeTo32Bytes } from './verify.js';
import type { ConnectProof } from './verify.js';

/** The op-message prefix, byte-identical to the on-chain prove_passkey handler. */
const SIWX_LOGIN_PREFIX = 'siwx_login';

export interface ConnectTabArgs {
  /** The challenge the relying app issued (same string the server will pass to verifyConnectProof). */
  challenge: string;
  /** base58 vault PDA being connected. */
  vault: string;
  /** 33-byte compressed P-256 passkey pubkey bound to the vault. */
  passkeyPubkey: Uint8Array;
  /** Raw WebAuthn credential ID bytes for the vault's passkey. */
  credentialId: Uint8Array;
  /** Optional WebAuthn RP id (defaults to the page's RP). */
  rpId?: string;
}

/**
 * Run the passkey assertion and return a verifier-ready ConnectProof.
 *
 * Browser-only (requires navigator.credentials). The returned proof feeds
 * straight into verifyConnectProof with the SAME challenge string.
 */
export async function connectTab(args: ConnectTabArgs): Promise<ConnectProof> {
  // 1. Relying-app challenge string → the 32-byte on-chain challenge. SAME fn
  //    the verifier uses, so both sides derive identical bytes.
  const challengeBytes = decodeChallengeTo32Bytes(args.challenge);

  // 2. op-message = utf8("siwx_login") || challengeBytes (direct concat).
  const prefix = new TextEncoder().encode(SIWX_LOGIN_PREFIX);
  const opMessage = new Uint8Array(prefix.length + challengeBytes.length);
  opMessage.set(prefix, 0);
  opMessage.set(challengeBytes, prefix.length);

  // 3. signedDigest = sha256(op-message) — the 32 bytes the ceremony signs over.
  const signedDigest = await sha256(opMessage);

  // 4. Run the WebAuthn assertion over the digest. The browser writes
  //    base64url(signedDigest) into clientDataJSON.challenge — exactly what
  //    prove_passkey reconstructs and the precompile signature is over.
  const signer = new WebAuthnAssertion({
    credentialId: args.credentialId,
    ...(args.rpId ? { rpId: args.rpId } : {}),
  });
  const assertion = await signer.assertOver(signedDigest);

  // 5. Assemble the ConnectProof exactly as the verifier consumes it.
  return {
    passkeyPubkey: args.passkeyPubkey,
    vault: args.vault,
    clientDataJSON: assertion.clientDataJSON,
    authenticatorData: assertion.authenticatorData,
    signature: assertion.signature, // 64-byte compact lowS r||s
  };
}

/**
 * SHA-256, browser (SubtleCrypto) with a Node fallback — mirrors the approach
 * in src/precompile/secp256r1.ts's buildPrecompileMessage so both code paths
 * hash identically.
 */
async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const subtle = (globalThis.crypto as { subtle?: SubtleCrypto } | undefined)?.subtle;
  if (subtle) {
    const buf = await subtle.digest('SHA-256', data as unknown as BufferSource);
    return new Uint8Array(buf);
  }
  const { createHash } = await import('node:crypto');
  return new Uint8Array(createHash('sha256').update(data).digest());
}
