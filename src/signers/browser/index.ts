/**
 * WebAuthnAssertion — pure-browser P-256 passkey ceremony.
 *
 * Runs `navigator.credentials.get()` over a server-issued challenge and
 * returns the three bytes the on-chain secp256r1 precompile + vault
 * program need:
 *
 *   - signature (64-byte compact r||s with low-S enforcement)
 *   - clientDataJSON  (raw, what the authenticator hashed)
 *   - authenticatorData (raw, what the authenticator signed)
 *
 * Zero `fetch` calls. The consumer composes this with whatever server
 * policy they enforce (replay defense, signature counter, AAGUID
 * capture). For Dexter that policy lives in dexter-fe's
 * `DexterApiBrowserPasskeySigner` adapter.
 *
 * The DER → compact lowS conversion is the canonical implementation —
 * it lifts verbatim from dexter-fe/app/lib/passkey.ts (which had it
 * duplicated in passkey-anon.ts). After v0.2 lands and dexter-fe
 * swaps, those two copies go away.
 */

import type { PasskeySigner } from '../types.js';

// ── Public types ──────────────────────────────────────────────────────────

export interface WebAuthnAssertionConfig {
  /** Raw credential ID bytes (NOT base64-encoded). */
  credentialId: Uint8Array;
  /** 33-byte SEC1 compressed P-256 pubkey, base64. Kept for symmetry / future use; not consumed by `assertOver`. */
  publicKeyBase64?: string;
  /** WebAuthn relying-party identifier. Defaults to omitting the field (browser uses the page's RP ID). */
  rpId?: string;
  /** Optional allow-list. Default: just `credentialId`. */
  allowCredentials?: Array<{
    id: Uint8Array;
    transports?: AuthenticatorTransport[];
  }>;
  /** WebAuthn timeout in milliseconds. Default 60_000. */
  timeoutMs?: number;
  /** UV requirement. Default "preferred". */
  userVerification?: UserVerificationRequirement;
}

export interface WebAuthnAssertionResult {
  /** 64-byte compact r||s P-256 signature, lowS-normalized (SIMD-0075 requires lowS). */
  signature: Uint8Array;
  /**
   * Raw DER-encoded ECDSA signature as returned by the authenticator,
   * BEFORE the compact-lowS conversion. Kept so consumers that need to
   * forward the assertion to a WebAuthn server library (which expects
   * DER) don't have to re-run the ceremony. The on-chain bytes are
   * `signature` (compact); DER is for server-side verify legs.
   */
  signatureDer: Uint8Array;
  /** Raw clientDataJSON as returned by the authenticator. */
  clientDataJSON: Uint8Array;
  /** Raw authenticatorData as returned by the authenticator. */
  authenticatorData: Uint8Array;
}

export class WebAuthnAssertionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'WebAuthnAssertionError';
  }
}

// ── The class ─────────────────────────────────────────────────────────────

/**
 * Pure-browser WebAuthn assertion driver. Implements `PasskeySigner` so
 * adapters that compose with server policy can plug straight in.
 */
export class WebAuthnAssertion implements PasskeySigner {
  readonly credentialId: Uint8Array;
  readonly publicKeyBase64?: string;
  private readonly rpId?: string;
  private readonly allowCredentials: Array<{
    id: Uint8Array;
    transports?: AuthenticatorTransport[];
  }>;
  private readonly timeoutMs: number;
  private readonly userVerification: UserVerificationRequirement;

  constructor(config: WebAuthnAssertionConfig) {
    if (!(config.credentialId instanceof Uint8Array) || config.credentialId.length === 0) {
      throw new WebAuthnAssertionError(
        'invalid_credential_id',
        'credentialId must be a non-empty Uint8Array',
      );
    }
    this.credentialId = config.credentialId;
    this.publicKeyBase64 = config.publicKeyBase64;
    this.rpId = config.rpId;
    this.allowCredentials =
      config.allowCredentials && config.allowCredentials.length > 0
        ? config.allowCredentials
        : [{ id: config.credentialId }];
    this.timeoutMs = config.timeoutMs ?? 60_000;
    this.userVerification = config.userVerification ?? 'preferred';
  }

  /**
   * Run `navigator.credentials.get()` over `challenge` and return the
   * three on-chain-ready buffers.
   *
   * The caller is responsible for what `challenge` *is*. For the vault
   * program, this is typically `sha256(opMessage)` minted server-side
   * with replay defense (see DexterApiBrowserPasskeySigner). The SDK
   * does not impose policy here.
   */
  async assertOver(challenge: Uint8Array): Promise<WebAuthnAssertionResult> {
    ensureBrowser();
    if (!(challenge instanceof Uint8Array) || challenge.length === 0) {
      throw new WebAuthnAssertionError(
        'invalid_challenge',
        'challenge must be a non-empty Uint8Array',
      );
    }

    const requestOptions: PublicKeyCredentialRequestOptions = {
      challenge: toBufferSource(challenge),
      allowCredentials: this.allowCredentials.map((c) => ({
        id: toBufferSource(c.id),
        type: 'public-key' as const,
        transports: c.transports,
      })),
      timeout: this.timeoutMs,
      userVerification: this.userVerification,
      ...(this.rpId ? { rpId: this.rpId } : {}),
    };

    const credential = (await navigator.credentials.get({
      publicKey: requestOptions,
    })) as PublicKeyCredential | null;

    if (!credential) {
      throw new WebAuthnAssertionError(
        'user_cancelled',
        'no assertion returned from authenticator',
      );
    }
    if (credential.type !== 'public-key') {
      throw new WebAuthnAssertionError(
        'credential_invalid',
        `unexpected credential type: ${credential.type}`,
      );
    }

    const assertion = credential.response as AuthenticatorAssertionResponse;
    const derSignature = new Uint8Array(assertion.signature);
    const compactSignature = derSignatureToCompactLowS(derSignature);

    return {
      signature: compactSignature,
      signatureDer: derSignature,
      clientDataJSON: new Uint8Array(assertion.clientDataJSON),
      authenticatorData: new Uint8Array(assertion.authenticatorData),
    };
  }

  /**
   * `PasskeySigner` shape — alias for `assertOver`. Consumers that want
   * to type against `PasskeySigner` (e.g. dexter-fe's
   * `DexterApiBrowserPasskeySigner`) call `.sign(challenge)`; consumers
   * that want the explicit name call `.assertOver(challenge)`. Same
   * function, two names.
   */
  sign(challenge: Uint8Array): Promise<WebAuthnAssertionResult> {
    return this.assertOver(challenge);
  }
}

// ── Helpers (file-private) ────────────────────────────────────────────────

function ensureBrowser(): void {
  if (typeof globalThis === 'undefined' || typeof (globalThis as { navigator?: Navigator }).navigator === 'undefined') {
    throw new WebAuthnAssertionError(
      'not_browser',
      'WebAuthnAssertion requires a browser environment (navigator.credentials)',
    );
  }
  const cred = (globalThis as { navigator: Navigator }).navigator.credentials;
  if (!cred || typeof cred.get !== 'function') {
    throw new WebAuthnAssertionError(
      'webauthn_unsupported',
      'this environment does not implement navigator.credentials.get',
    );
  }
}

function toBufferSource(bytes: Uint8Array): ArrayBuffer {
  // Force a fresh ArrayBuffer-backed view so strict typings accept it as
  // BufferSource. Some bundlers tighten the BufferSource contract.
  const out = new ArrayBuffer(bytes.length);
  new Uint8Array(out).set(bytes);
  return out;
}

// ── DER → compact lowS — canonical implementation ─────────────────────────
//
// Lifted verbatim from dexter-fe/app/lib/passkey.ts:253-313 (the same
// code was duplicated in passkey-anon.ts:249-309). This becomes the
// single source of truth after v0.2 ships.

const P256_ORDER = BigInt(
  '0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551',
);
const P256_HALF_ORDER = P256_ORDER >> BigInt(1);

function bigintFromBytes(buf: Uint8Array): bigint {
  let n = 0n;
  for (const byte of buf) n = (n << 8n) | BigInt(byte);
  return n;
}

function bytesFromBigint(n: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = length - 1; i >= 0; i -= 1) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

/**
 * Parse an ASN.1 DER ECDSA signature and return the 64-byte (r||s) form
 * with s normalized to lowS (s ≤ n/2). SIMD-0075 rejects high-S
 * signatures to prevent malleability replay.
 *
 * Exported so byte-parity tests can lock the conversion against the
 * dexter-fe implementation it replaces.
 */
export { DexterApiBrowserPasskeySigner } from './dexterApiSigner.js';
export type { ServerPolicy, DexterApiSignerConfig } from './dexterApiSigner.js';

export function derSignatureToCompactLowS(der: Uint8Array): Uint8Array {
  let i = 0;
  if (der[i++] !== 0x30) {
    throw new WebAuthnAssertionError('bad_signature', 'expected DER SEQUENCE');
  }
  // sequence length byte — we don't enforce it strictly because the outer
  // length isn't load-bearing for correctness; the inner INTEGER lengths
  // are what we actually parse.
  i++;

  if (der[i++] !== 0x02) {
    throw new WebAuthnAssertionError('bad_signature', 'expected r INTEGER');
  }
  const rLen = der[i++];
  if (rLen === undefined) {
    throw new WebAuthnAssertionError('bad_signature', 'truncated DER (no r length)');
  }
  let r = der.slice(i, i + rLen);
  i += rLen;

  if (der[i++] !== 0x02) {
    throw new WebAuthnAssertionError('bad_signature', 'expected s INTEGER');
  }
  const sLen = der[i++];
  if (sLen === undefined) {
    throw new WebAuthnAssertionError('bad_signature', 'truncated DER (no s length)');
  }
  let s = der.slice(i, i + sLen);
  i += sLen;

  // DER may include a 0x00 leading byte to keep the integer positive.
  if (r.length > 32 && r[0] === 0x00) r = r.slice(1);
  if (s.length > 32 && s[0] === 0x00) s = s.slice(1);

  if (r.length > 32 || s.length > 32) {
    throw new WebAuthnAssertionError(
      'bad_signature',
      'DER component too large for P-256',
    );
  }

  const rPadded = new Uint8Array(32);
  rPadded.set(r, 32 - r.length);
  let sN = bigintFromBytes(s);
  if (sN > P256_HALF_ORDER) sN = P256_ORDER - sN;
  const sPadded = bytesFromBigint(sN, 32);

  const out = new Uint8Array(64);
  out.set(rPadded, 0);
  out.set(sPadded, 32);
  return out;
}
