/**
 * enrollPasskey — backend-free WebAuthn create() ceremony.
 *
 * Generates a local 16-byte userHandle (no server round-trip), runs
 * navigator.credentials.create(), and extracts the 33-byte SEC1-compressed
 * P-256 public key from the attestationObject. Consumed by Task 4 (turnkey
 * vault creation) to build the initialize_vault instruction.
 *
 * Zero on-chain writes. Pure client-side ceremony.
 *
 * parseAttestationToSec1 mirrors the hand-rolled CBOR mini-parser in
 * dexter-api/src/routes/passkeyEnrollAnon.ts (coseEs256ToSec1Compressed),
 * extended to start from the raw attestationObject rather than a pre-extracted
 * COSE key. No external CBOR dep is added — the SDK has none and doesn't need
 * one for this limited format.
 */

import { generateUserHandle } from './userHandle.js';

// ── Public types ─────────────────────────────────────────────────────────────

export interface EnrollOptions {
  rpId: string;
  rpName: string;
  userName: string;
  timeoutMs?: number;
  /** Test seam: parse attestationObject → 33-byte SEC1 pubkey. Defaults to the
   *  real parser. Production callers do NOT pass this. */
  __parseAttestation?: (attestationObject: Uint8Array) => Uint8Array;
}

export interface EnrollResult {
  credentialId: Uint8Array;
  publicKeyBase64: string; // 33-byte SEC1 compressed P-256, base64
  userHandle: Uint8Array; // 16 bytes
}

export class EnrollError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'EnrollError';
  }
}

// ── Guards ────────────────────────────────────────────────────────────────────

function ensureBrowser(): void {
  if (
    typeof window === 'undefined' ||
    typeof (globalThis as Record<string, unknown>)['PublicKeyCredential'] === 'undefined'
  ) {
    throw new EnrollError(
      'webauthn_unsupported',
      'enrollPasskey requires a browser WebAuthn environment',
    );
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run the WebAuthn create() ceremony with a locally-generated 16-byte
 * userHandle (backend-free). Returns the credential id, the SEC1-compressed
 * P-256 pubkey (for initialize_vault's passkey_pubkey), and the userHandle.
 */
export async function enrollPasskey(opts: EnrollOptions): Promise<EnrollResult> {
  ensureBrowser();
  const userHandle = generateUserHandle();

  // Copy into a plain ArrayBuffer-backed Uint8Array so strict BufferSource
  // typings accept it (SharedArrayBuffer-backed inputs are rejected by the
  // DOM type for PublicKeyCredentialCreationOptions.user.id).
  const challengeBuf = new Uint8Array(32);
  globalThis.crypto.getRandomValues(challengeBuf);
  const userHandleBuf = new Uint8Array(userHandle);

  const cred = (await navigator.credentials.create({
    publicKey: {
      challenge: challengeBuf.buffer,
      rp: { id: opts.rpId, name: opts.rpName },
      user: { id: userHandleBuf.buffer, name: opts.userName, displayName: opts.userName },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }], // ES256 / P-256
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'preferred',
      },
      timeout: opts.timeoutMs ?? 60_000,
    },
  })) as PublicKeyCredential | null;

  if (!cred || cred.type !== 'public-key') {
    throw new EnrollError('no_credential', 'WebAuthn create() returned no credential');
  }

  const att = cred.response as AuthenticatorAttestationResponse;
  const parse = opts.__parseAttestation ?? parseAttestationToSec1;
  const publicKey = parse(new Uint8Array(att.attestationObject));

  return {
    credentialId: new Uint8Array(cred.rawId),
    publicKeyBase64: toBase64(publicKey),
    userHandle,
  };
}

// ── attestationObject → SEC1 parser ──────────────────────────────────────────
//
// Approach: hand-rolled CBOR mini-parser (no external lib) that covers the
// subset of CBOR used in a WebAuthn attestationObject. Mirrors the parser in
// dexter-api/src/routes/passkeyEnrollAnon.ts (coseEs256ToSec1Compressed +
// decodeCborInt/decodeCborValue), extended to walk the outer attestationObject
// map and the authData binary structure.
//
// attestationObject CBOR map has three text-keyed entries:
//   "fmt"      → text   (attestation format, e.g. "none")
//   "attStmt"  → map    (format-specific statement; ignored here)
//   "authData" → bstr   (raw authenticator data bytes)
//
// authData layout (WebAuthn §6.1):
//   32  bytes  rpIdHash
//    1  byte   flags  (bit 6 = AT = attested credential data present)
//    4  bytes  signCount
//   if AT flag set:
//     16  bytes  aaguid
//      2  bytes  credentialIdLength (BE)
//      N  bytes  credentialId
//      M  bytes  credentialPublicKey (CBOR COSE_Key)
//
// COSE_Key for ES256 (alg=-7, P-256):
//   map { 1:2, 3:-7, -1:1, -2:bstr(32) x, -3:bstr(32) y }
//
// SEC1 compressed: 0x02 if y[31] even, 0x03 if y[31] odd, then 32-byte x.

/**
 * Parse a WebAuthn attestationObject to a 33-byte SEC1-compressed P-256 pubkey.
 * Exported so it can be tested directly against known vectors.
 */
export function parseAttestationToSec1(attestationObject: Uint8Array): Uint8Array {
  // ── 1. Decode outer CBOR map ──────────────────────────────────────────────
  let i = 0;
  const first = attestationObject[i];
  if (first === undefined || (first & 0xe0) !== 0xa0) {
    throw new EnrollError('bad_attestation', 'attestationObject: expected CBOR map');
  }
  const mapLen = first & 0x1f;
  i += 1;

  let authData: Uint8Array | undefined;

  for (let n = 0; n < mapLen; n++) {
    // Key is always a text string in a standard attestationObject
    const keyResult = cborDecodeTextOrSkip(attestationObject, i);
    i = keyResult.next;

    if (keyResult.key === 'authData') {
      // Value is a byte string
      const valResult = cborDecodeByteString(attestationObject, i);
      i = valResult.next;
      authData = valResult.value;
    } else {
      // Skip value (fmt = text, attStmt = map — we don't need them)
      i = cborSkipValue(attestationObject, i);
    }
  }

  if (!authData) {
    throw new EnrollError('bad_attestation', 'attestationObject: missing authData');
  }

  // ── 2. Parse authData ─────────────────────────────────────────────────────
  if (authData.length < 37) {
    throw new EnrollError(
      'bad_auth_data',
      `authData too short: ${authData.length} bytes (need ≥37)`,
    );
  }

  const flags = authData[32];
  if (flags === undefined) {
    throw new EnrollError('bad_auth_data', 'authData: flags byte missing');
  }
  const AT_FLAG = 1 << 6;
  if ((flags & AT_FLAG) === 0) {
    throw new EnrollError(
      'bad_auth_data',
      'authData AT flag not set — no attested credential data present',
    );
  }

  // Skip rpIdHash(32) + flags(1) + counter(4) + aaguid(16) = 53 bytes
  let adOff = 32 + 1 + 4 + 16; // = 53

  // credentialIdLength: 2 bytes big-endian
  const credIdLen = (authData[adOff]! << 8) | authData[adOff + 1]!;
  adOff += 2;

  // Skip credentialId
  adOff += credIdLen;

  if (adOff >= authData.length) {
    throw new EnrollError('bad_auth_data', 'authData: no bytes remaining for credentialPublicKey');
  }

  const coseKey = authData.slice(adOff);

  // ── 3. Extract x, y from COSE_Key ────────────────────────────────────────
  return coseEs256ToSec1(coseKey);
}

// ── COSE_Key → SEC1 ───────────────────────────────────────────────────────────
//
// Ported directly from dexter-api/src/routes/passkeyEnrollAnon.ts
// (coseEs256ToSec1Compressed + decodeCborInt/decodeCborValue), adapted to
// throw EnrollError rather than generic Error.

function coseEs256ToSec1(coseKey: Uint8Array): Uint8Array {
  const map: Record<number, Uint8Array | number> = {};
  let i = 0;
  const first = coseKey[i];
  if (first === undefined || (first & 0xe0) !== 0xa0) {
    throw new EnrollError('bad_cose_key', 'COSE_Key: expected CBOR map');
  }
  const mapLen = first & 0x1f;
  i += 1;

  for (let n = 0; n < mapLen; n++) {
    const k = cborDecodeInt(coseKey, i);
    i = k.next;
    const v = cborDecodeValue(coseKey, i);
    i = v.next;
    map[k.value] = v.value;
  }

  const x = map[-2] as Uint8Array | undefined;
  const y = map[-3] as Uint8Array | undefined;
  if (!x || !y || x.length !== 32 || y.length !== 32) {
    throw new EnrollError('bad_cose_key', 'COSE_Key: invalid ES256 key (missing x or y)');
  }

  const prefix = (y[31]! & 1) === 0 ? 0x02 : 0x03;
  const out = new Uint8Array(33);
  out[0] = prefix;
  out.set(x, 1);
  return out;
}

// ── Minimal CBOR helpers ──────────────────────────────────────────────────────

function cborDecodeInt(buf: Uint8Array, i: number): { value: number; next: number } {
  const b = buf[i];
  if (b === undefined) throw new EnrollError('bad_cbor', `CBOR: unexpected end at offset ${i}`);
  const major = b >> 5;
  const small = b & 0x1f;

  if (major === 0) {
    // Unsigned int
    if (small < 24) return { value: small, next: i + 1 };
    if (small === 24) {
      const v = buf[i + 1];
      if (v === undefined) throw new EnrollError('bad_cbor', 'CBOR: truncated uint8');
      return { value: v, next: i + 2 };
    }
    if (small === 25) {
      const hi = buf[i + 1]; const lo = buf[i + 2];
      if (hi === undefined || lo === undefined) throw new EnrollError('bad_cbor', 'CBOR: truncated uint16');
      return { value: (hi << 8) | lo, next: i + 3 };
    }
  }
  if (major === 1) {
    // Negative int: value = -1 - n
    if (small < 24) return { value: -1 - small, next: i + 1 };
    if (small === 24) {
      const v = buf[i + 1];
      if (v === undefined) throw new EnrollError('bad_cbor', 'CBOR: truncated neg uint8');
      return { value: -1 - v, next: i + 2 };
    }
    if (small === 25) {
      const hi = buf[i + 1]; const lo = buf[i + 2];
      if (hi === undefined || lo === undefined) throw new EnrollError('bad_cbor', 'CBOR: truncated neg uint16');
      return { value: -1 - ((hi << 8) | lo), next: i + 3 };
    }
  }
  throw new EnrollError('bad_cbor', `CBOR: unsupported int encoding at offset ${i} (byte=0x${b.toString(16)})`);
}

function cborDecodeValue(
  buf: Uint8Array,
  i: number,
): { value: Uint8Array | number; next: number } {
  const b = buf[i];
  if (b === undefined) throw new EnrollError('bad_cbor', `CBOR: unexpected end at offset ${i}`);
  const major = b >> 5;

  if (major === 0 || major === 1) return cborDecodeInt(buf, i);

  if (major === 2) {
    // Byte string
    const small = b & 0x1f;
    let len: number;
    let off: number;
    if (small < 24) { len = small; off = i + 1; }
    else if (small === 24) {
      const v = buf[i + 1];
      if (v === undefined) throw new EnrollError('bad_cbor', 'CBOR: truncated bstr len');
      len = v; off = i + 2;
    } else if (small === 25) {
      const hi = buf[i + 1]; const lo = buf[i + 2];
      if (hi === undefined || lo === undefined) throw new EnrollError('bad_cbor', 'CBOR: truncated bstr len16');
      len = (hi << 8) | lo; off = i + 3;
    } else {
      throw new EnrollError('bad_cbor', `CBOR: unsupported bstr length encoding at ${i}`);
    }
    return { value: buf.slice(off, off + len), next: off + len };
  }

  throw new EnrollError('bad_cbor', `CBOR: unsupported major type ${major} at offset ${i}`);
}

/** Decode a text-string key from the attestationObject map. Returns the string
 *  value and the offset after the key, or null key if decoding as text fails. */
function cborDecodeTextOrSkip(
  buf: Uint8Array,
  i: number,
): { key: string | null; next: number } {
  const b = buf[i];
  if (b === undefined) throw new EnrollError('bad_cbor', `CBOR: unexpected end at offset ${i}`);
  const major = b >> 5;
  if (major !== 3) {
    // Not a text string — skip it as a value and return null key
    return { key: null, next: cborSkipValue(buf, i) };
  }
  const small = b & 0x1f;
  let len: number;
  let off: number;
  if (small < 24) { len = small; off = i + 1; }
  else if (small === 24) {
    const v = buf[i + 1];
    if (v === undefined) throw new EnrollError('bad_cbor', 'CBOR: truncated text len');
    len = v; off = i + 2;
  } else if (small === 25) {
    const hi = buf[i + 1]; const lo = buf[i + 2];
    if (hi === undefined || lo === undefined) throw new EnrollError('bad_cbor', 'CBOR: truncated text len16');
    len = (hi << 8) | lo; off = i + 3;
  } else {
    throw new EnrollError('bad_cbor', `CBOR: unsupported text length encoding at ${i}`);
  }
  const bytes = buf.slice(off, off + len);
  const key = new TextDecoder().decode(bytes);
  return { key, next: off + len };
}

function cborDecodeByteString(
  buf: Uint8Array,
  i: number,
): { value: Uint8Array; next: number } {
  const b = buf[i];
  if (b === undefined) throw new EnrollError('bad_cbor', `CBOR: unexpected end at offset ${i}`);
  const major = b >> 5;
  if (major !== 2) {
    throw new EnrollError(
      'bad_cbor',
      `CBOR: expected byte string (major 2) at offset ${i}, got major ${major}`,
    );
  }
  const small = b & 0x1f;
  let len: number;
  let off: number;
  if (small < 24) { len = small; off = i + 1; }
  else if (small === 24) {
    const v = buf[i + 1];
    if (v === undefined) throw new EnrollError('bad_cbor', 'CBOR: truncated bstr len');
    len = v; off = i + 2;
  } else if (small === 25) {
    const hi = buf[i + 1]; const lo = buf[i + 2];
    if (hi === undefined || lo === undefined) throw new EnrollError('bad_cbor', 'CBOR: truncated bstr len16');
    len = (hi << 8) | lo; off = i + 3;
  } else if (small === 26) {
    const b1 = buf[i+1]; const b2 = buf[i+2]; const b3 = buf[i+3]; const b4 = buf[i+4];
    if (b1 === undefined || b2 === undefined || b3 === undefined || b4 === undefined) {
      throw new EnrollError('bad_cbor', 'CBOR: truncated bstr len32');
    }
    len = (b1 * 2**24) + (b2 << 16) + (b3 << 8) + b4;
    off = i + 5;
  } else {
    throw new EnrollError('bad_cbor', `CBOR: unsupported bstr length encoding at ${i}`);
  }
  return { value: buf.slice(off, off + len), next: off + len };
}

/** Skip a single CBOR value at position i, returning the offset after it. */
function cborSkipValue(buf: Uint8Array, i: number): number {
  const b = buf[i];
  if (b === undefined) throw new EnrollError('bad_cbor', `CBOR: unexpected end at offset ${i}`);
  const major = b >> 5;
  const small = b & 0x1f;

  if (major === 0 || major === 1) {
    // Integer
    if (small < 24) return i + 1;
    if (small === 24) return i + 2;
    if (small === 25) return i + 3;
    if (small === 26) return i + 5;
    if (small === 27) return i + 9;
    throw new EnrollError('bad_cbor', `CBOR: unsupported int at ${i}`);
  }
  if (major === 2 || major === 3) {
    // Byte or text string
    let len: number;
    let off: number;
    if (small < 24) { len = small; off = i + 1; }
    else if (small === 24) {
      const v = buf[i + 1];
      if (v === undefined) throw new EnrollError('bad_cbor', 'CBOR: truncated str len');
      len = v; off = i + 2;
    } else if (small === 25) {
      const hi = buf[i + 1]; const lo = buf[i + 2];
      if (hi === undefined || lo === undefined) throw new EnrollError('bad_cbor', 'CBOR: truncated str len16');
      len = (hi << 8) | lo; off = i + 3;
    } else if (small === 26) {
      const b1 = buf[i+1]; const b2 = buf[i+2]; const b3 = buf[i+3]; const b4 = buf[i+4];
      if (b1 === undefined || b2 === undefined || b3 === undefined || b4 === undefined) {
        throw new EnrollError('bad_cbor', 'CBOR: truncated str len32');
      }
      len = (b1 * 2**24) + (b2 << 16) + (b3 << 8) + b4;
      off = i + 5;
    } else {
      throw new EnrollError('bad_cbor', `CBOR: unsupported str length encoding at ${i}`);
    }
    return off + len;
  }
  if (major === 4) {
    // Array — skip each element
    let count: number;
    let off: number;
    if (small < 24) { count = small; off = i + 1; }
    else if (small === 24) {
      const v = buf[i + 1];
      if (v === undefined) throw new EnrollError('bad_cbor', 'CBOR: truncated array len');
      count = v; off = i + 2;
    } else {
      throw new EnrollError('bad_cbor', `CBOR: unsupported array length at ${i}`);
    }
    for (let n = 0; n < count; n++) off = cborSkipValue(buf, off);
    return off;
  }
  if (major === 5) {
    // Map — skip key+value for each pair
    let count: number;
    let off: number;
    if (small < 24) { count = small; off = i + 1; }
    else if (small === 24) {
      const v = buf[i + 1];
      if (v === undefined) throw new EnrollError('bad_cbor', 'CBOR: truncated map len');
      count = v; off = i + 2;
    } else {
      throw new EnrollError('bad_cbor', `CBOR: unsupported map length at ${i}`);
    }
    for (let n = 0; n < count; n++) {
      off = cborSkipValue(buf, off); // key
      off = cborSkipValue(buf, off); // value
    }
    return off;
  }
  if (major === 7) {
    // Simple values / float
    if (small < 24) return i + 1;
    if (small === 24) return i + 2;
    if (small === 25) return i + 3;
    if (small === 26) return i + 5;
    if (small === 27) return i + 9;
    throw new EnrollError('bad_cbor', `CBOR: unsupported simple value at ${i}`);
  }
  throw new EnrollError('bad_cbor', `CBOR: unsupported major type ${major} at offset ${i}`);
}
