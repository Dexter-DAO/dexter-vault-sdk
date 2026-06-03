/**
 * Byte-parity tests for the secp256r1 + Ed25519 precompile builders.
 *
 * The precompile instruction layout is what the on-chain handler reads via
 * SYSVAR_INSTRUCTIONS to verify a passkey or session-key signature. If any
 * byte in the offsets-table or the contiguous payload drifts, every
 * passkey-signed instruction silently fails on chain. These snapshots are
 * the structural lock.
 */
import { describe, test, expect } from 'vitest';
import {
  buildSecp256r1VerifyInstruction,
  buildPrecompileMessage,
  buildEd25519VerifyInstruction,
} from '../src/precompile/index.js';
import { SECP256R1_PROGRAM_ID, ED25519_PROGRAM_ID } from '../src/constants/index.js';

// Distinct repeating bytes so a snapshot diff visibly identifies which field shifted.
const KNOWN_P256_PUBKEY = new Uint8Array(33).fill(0xCC);
const KNOWN_P256_SIG    = new Uint8Array(64).fill(0xC1);
const KNOWN_ED25519_PK  = new Uint8Array(32).fill(0xAA);
const KNOWN_ED25519_SIG = new Uint8Array(64).fill(0xA1);
const KNOWN_AUTH_DATA   = new Uint8Array([5, 6, 7, 8]);
const KNOWN_CLIENT_DATA = new Uint8Array([1, 2, 3, 4]);
const KNOWN_VOUCHER_MSG = new Uint8Array(44).fill(0xBB);

describe('secp256r1 precompile', () => {
  test('program ID matches the SIMD-0075 verifier', () => {
    expect(SECP256R1_PROGRAM_ID.toBase58()).toBe('Secp256r1SigVerify1111111111111111111111111');
  });

  test('instruction data layout (snapshot)', () => {
    const ix = buildSecp256r1VerifyInstruction(
      KNOWN_P256_PUBKEY,
      KNOWN_P256_SIG,
      // Use a fixed-length placeholder message so the snapshot is byte-stable.
      new Uint8Array(36).fill(0xDD),
    );
    expect(ix.programId.toBase58()).toBe('Secp256r1SigVerify1111111111111111111111111');
    expect(ix.keys.length).toBe(0);
    expect(new Uint8Array(ix.data)).toMatchSnapshot('secp256r1 verify data');
  });

  test('throws on wrong pubkey length', () => {
    expect(() => buildSecp256r1VerifyInstruction(
      new Uint8Array(32),                     // wrong: need 33
      new Uint8Array(64),
      new Uint8Array(36),
    )).toThrow();
  });

  test('throws on wrong signature length', () => {
    expect(() => buildSecp256r1VerifyInstruction(
      new Uint8Array(33),
      new Uint8Array(63),                     // wrong: need 64
      new Uint8Array(36),
    )).toThrow();
  });
});

describe('precompile message assembly (authData || SHA-256(clientDataJSON))', () => {
  test('known-input snapshot', async () => {
    const out = await buildPrecompileMessage(KNOWN_CLIENT_DATA, KNOWN_AUTH_DATA);
    // 4 bytes auth + 32 bytes SHA-256 = 36 bytes total.
    expect(out.length).toBe(KNOWN_AUTH_DATA.length + 32);
    expect(out.subarray(0, KNOWN_AUTH_DATA.length)).toEqual(KNOWN_AUTH_DATA);
    expect(out).toMatchSnapshot('precompile message bytes');
  });

  test('SHA-256 of clientDataJSON is deterministic', async () => {
    const a = await buildPrecompileMessage(KNOWN_CLIENT_DATA, KNOWN_AUTH_DATA);
    const b = await buildPrecompileMessage(KNOWN_CLIENT_DATA, KNOWN_AUTH_DATA);
    expect(Buffer.from(a)).toEqual(Buffer.from(b));
  });
});

describe('Ed25519 precompile', () => {
  test('program ID matches the Ed25519 verifier', () => {
    expect(ED25519_PROGRAM_ID.toBase58()).toBe('Ed25519SigVerify111111111111111111111111111');
  });

  test('instruction data layout (snapshot)', () => {
    const ix = buildEd25519VerifyInstruction(KNOWN_ED25519_PK, KNOWN_ED25519_SIG, KNOWN_VOUCHER_MSG);
    expect(ix.programId.toBase58()).toBe('Ed25519SigVerify111111111111111111111111111');
    expect(ix.keys.length).toBe(0);
    expect(new Uint8Array(ix.data)).toMatchSnapshot('ed25519 verify data');
  });

  test('throws on wrong pubkey length', () => {
    expect(() => buildEd25519VerifyInstruction(
      new Uint8Array(31),                     // wrong: need 32
      new Uint8Array(64),
      KNOWN_VOUCHER_MSG,
    )).toThrow();
  });

  test('throws on wrong signature length', () => {
    expect(() => buildEd25519VerifyInstruction(
      new Uint8Array(32),
      new Uint8Array(65),                     // wrong: need 64
      KNOWN_VOUCHER_MSG,
    )).toThrow();
  });
});
