/**
 * Known-vector test for parseAttestationToSec1.
 *
 * Vector provenance: constructed programmatically using @noble/curves p256
 * (already a vault-sdk dependency) to generate a deterministic P-256 key pair
 * from private scalar 42, then encoded into a minimal "none" attestation
 * (fmt="none", attStmt={}, authData=<standard layout with COSE key>).
 * The approach mirrors how dexter-api/src/routes/passkeyEnrollAnon.ts
 * (coseEs256ToSec1Compressed) extracts the public key from the credential's
 * COSE_Key, adapted here to start from the raw attestationObject bytes.
 *
 * Expected output:
 *   private key scalar = 42
 *   x = 6780c5fc70275e2c7061a0e7877bb174deadeb9887027f3fa83654158ba7f50c
 *   y = 3cba8c34bc35d20e81f730ac1c7bd6d661a942f90c6a9ca55c512f9e4a001266
 *   y[31] = 0x66 (even) → prefix = 0x02
 *   SEC1 = 026780c5fc70275e2c7061a0e7877bb174deadeb9887027f3fa83654158ba7f50c
 *   base64 = AmeAxfxwJ14scGGg54d7sXTereuYhwJ/P6g2VBWLp/UM
 */

import { describe, it, expect } from 'vitest';
import { parseAttestationToSec1 } from '../enroll.js';

// ── Known test vector ──────────────────────────────────────────────────────────
//
// attestationObject = CBOR { "fmt":"none", "attStmt":{}, "authData": bstr }
// authData contains a COSE_Key built from P-256 key with scalar=42.
// Generated via the script at the bottom of this comment block.
//
// Construction verified by @noble/curves p256.getPublicKey(privKey42, true):
//   expected SEC1 = 026780c5fc70275e2c7061a0e7877bb174deadeb9887027f3fa83654158ba7f50c
//
// To regenerate this hex independently:
//   node --input-type=module << 'EOF'
//   import { p256 } from '@noble/curves/p256';
//   const priv = new Uint8Array(32); priv[31] = 42;
//   console.log(Buffer.from(p256.getPublicKey(priv, true)).toString('hex'));
//   EOF

const ATTESTATION_OBJECT_HEX =
  'a363666d74646e6f6e656761747453746d74a06861757468446174615888' +
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' +
  '45' +                              // flags: UP | UV | AT
  '00000001' +                        // counter = 1
  '00000000000000000000000000000000' + // aaguid (16 zero bytes)
  '0004' +                            // credentialIdLength = 4
  '01020304' +                        // credentialId
  'a50102032620012158206780c5fc70275e2c7061a0e7877bb174deadeb9887027f3fa83654158ba7f50c' +
  '2258203cba8c34bc35d20e81f730ac1c7bd6d661a942f90c6a9ca55c512f9e4a001266';

// Expected 33-byte SEC1 compressed P-256 public key (verified against @noble/curves)
const EXPECTED_SEC1_HEX =
  '026780c5fc70275e2c7061a0e7877bb174deadeb9887027f3fa83654158ba7f50c';
const EXPECTED_SEC1_BASE64 = 'AmeAxfxwJ14scGGg54d7sXTereuYhwJ/P6g2VBWLp/UM';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('parseAttestationToSec1', () => {
  it('returns exactly 33 bytes', () => {
    const attestationObject = Buffer.from(ATTESTATION_OBJECT_HEX, 'hex');
    const result = parseAttestationToSec1(attestationObject);
    expect(result).toHaveLength(33);
  });

  it('produces the exact SEC1 bytes for the known vector', () => {
    const attestationObject = Buffer.from(ATTESTATION_OBJECT_HEX, 'hex');
    const result = parseAttestationToSec1(attestationObject);
    expect(Buffer.from(result).toString('hex')).toBe(EXPECTED_SEC1_HEX);
  });

  it('produces the exact base64 output for the known vector', () => {
    const attestationObject = Buffer.from(ATTESTATION_OBJECT_HEX, 'hex');
    const result = parseAttestationToSec1(attestationObject);
    expect(Buffer.from(result).toString('base64')).toBe(EXPECTED_SEC1_BASE64);
  });

  it('prefix is 0x02 (even y-coordinate) for this vector', () => {
    const attestationObject = Buffer.from(ATTESTATION_OBJECT_HEX, 'hex');
    const result = parseAttestationToSec1(attestationObject);
    expect(result[0]).toBe(0x02);
  });

  it('throws EnrollError when attestationObject is not a CBOR map', () => {
    expect(() =>
      parseAttestationToSec1(new Uint8Array([0x01, 0x02, 0x03])),
    ).toThrow(/expected CBOR map/i);
  });

  it('throws EnrollError when AT flag is not set', () => {
    // Build an authData with AT flag cleared (flags = 0x05 instead of 0x45)
    const authData = Buffer.from(
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' + // rpIdHash
      '05' + // flags: UP | UV but NO AT
      '00000000', // counter
      'hex',
    );
    // Encode as a minimal attestationObject
    const ao = buildMinimalAttestationObject(authData);
    expect(() => parseAttestationToSec1(ao)).toThrow(/AT flag/i);
  });
});

// ── Helper to build a minimal attestationObject for error-path tests ──────────

function buildMinimalAttestationObject(authData: Uint8Array): Uint8Array {
  function cbText(s: string): number[] {
    const enc = new TextEncoder().encode(s);
    return enc.length < 24 ? [0x60 | enc.length, ...enc] : [0x78, enc.length, ...enc];
  }
  function cbBstr(b: Uint8Array): number[] {
    if (b.length < 24) return [0x40 | b.length, ...b];
    if (b.length < 256) return [0x58, b.length, ...b];
    return [0x59, (b.length >> 8) & 0xff, b.length & 0xff, ...b];
  }
  return new Uint8Array([
    0xa3,
    ...cbText('fmt'), ...cbText('none'),
    ...cbText('attStmt'), 0xa0,
    ...cbText('authData'), ...cbBstr(authData),
  ]);
}
