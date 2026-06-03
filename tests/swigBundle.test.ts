/**
 * Structural smoke for buildSwigCreationBundle.
 *
 * This is the test the @dexterai/vault extract exists to make possible.
 *
 * The "Role not found for ID: 3" bug happened because three places hand-rolled
 * the same Swig role list and one of them missed role 3 (the settle_tab_voucher
 * ProgramExec marker). After the extract, the role list lives in exactly one
 * file (src/instructions/swigBundle.ts). This test pins:
 *
 *   1. The bundle produces ≥4 instructions (Swig CreateV1 + role 1 + role 2 + role 3).
 *   2. The settle_tab_voucher discriminator is registered as a Swig exec marker.
 *   3. Same inputs → same Swig PDA (idempotent).
 *   4. expectedSwigAddressFor returns a valid base58 PublicKey.
 *
 * No on-chain interaction. Pure structural assertions against the in-memory
 * instruction list the bundle returns.
 */
import { describe, test, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import {
  buildSwigCreationBundle,
  expectedSwigAddressFor,
  SWIG_PROGRAM_EXEC_PREFIX,
  SWIG_PROGRAM_EXEC_PREFIX_SETTLE_TAB,
  SWIG_PROGRAM_EXEC_MARKERS,
} from '../src/instructions/index.js';

// Stable test inputs. The fee-payer must be a valid base58 pubkey (Swig kit
// validates), so use a sentinel pubkey. dexterMasterPubkey likewise.
const KNOWN_FEE_PAYER       = 'Sysvar1nstructions1111111111111111111111111';
const KNOWN_DEXTER_MASTER   = 'Ed25519SigVerify111111111111111111111111111';
const KNOWN_IDENTITY_SEED   = new Uint8Array(16).fill(0x42);
const KNOWN_HMAC_KEY        = new Uint8Array(32).fill(0x9F);

describe('buildSwigCreationBundle structural lock', () => {
  test('bundle produces ≥4 instructions (CreateV1 + role 1 + role 2 + role 3)', async () => {
    const bundle = await buildSwigCreationBundle({
      feePayer: KNOWN_FEE_PAYER,
      dexterMasterPubkey: KNOWN_DEXTER_MASTER,
      identitySeed: KNOWN_IDENTITY_SEED,
      hmacKey: KNOWN_HMAC_KEY,
    });
    expect(bundle.instructions.length).toBeGreaterThanOrEqual(4);
  });

  test('returns a valid base58 Swig PDA', async () => {
    const bundle = await buildSwigCreationBundle({
      feePayer: KNOWN_FEE_PAYER,
      dexterMasterPubkey: KNOWN_DEXTER_MASTER,
      identitySeed: KNOWN_IDENTITY_SEED,
      hmacKey: KNOWN_HMAC_KEY,
    });
    // Will throw if the address isn't a base58-valid 32-byte pubkey.
    const pk = new PublicKey(bundle.swigAddress);
    expect(pk.toBase58()).toBe(bundle.swigAddress);
    expect(bundle.swigIdBase58.length).toBeGreaterThan(0);
  });

  test('idempotent: same inputs → same Swig address', async () => {
    const a = await buildSwigCreationBundle({
      feePayer: KNOWN_FEE_PAYER,
      dexterMasterPubkey: KNOWN_DEXTER_MASTER,
      identitySeed: KNOWN_IDENTITY_SEED,
      hmacKey: KNOWN_HMAC_KEY,
    });
    const b = await buildSwigCreationBundle({
      feePayer: KNOWN_FEE_PAYER,
      dexterMasterPubkey: KNOWN_DEXTER_MASTER,
      identitySeed: KNOWN_IDENTITY_SEED,
      hmacKey: KNOWN_HMAC_KEY,
    });
    expect(a.swigAddress).toBe(b.swigAddress);
    expect(a.swigIdBase58).toBe(b.swigIdBase58);
  });

  test('different identitySeed → different Swig address', async () => {
    const a = await buildSwigCreationBundle({
      feePayer: KNOWN_FEE_PAYER,
      dexterMasterPubkey: KNOWN_DEXTER_MASTER,
      identitySeed: KNOWN_IDENTITY_SEED,
      hmacKey: KNOWN_HMAC_KEY,
    });
    const b = await buildSwigCreationBundle({
      feePayer: KNOWN_FEE_PAYER,
      dexterMasterPubkey: KNOWN_DEXTER_MASTER,
      identitySeed: new Uint8Array(16).fill(0x43),
      hmacKey: KNOWN_HMAC_KEY,
    });
    expect(a.swigAddress).not.toBe(b.swigAddress);
  });

  test('different hmacKey → different Swig address (server secret matters)', async () => {
    const a = await buildSwigCreationBundle({
      feePayer: KNOWN_FEE_PAYER,
      dexterMasterPubkey: KNOWN_DEXTER_MASTER,
      identitySeed: KNOWN_IDENTITY_SEED,
      hmacKey: KNOWN_HMAC_KEY,
    });
    const b = await buildSwigCreationBundle({
      feePayer: KNOWN_FEE_PAYER,
      dexterMasterPubkey: KNOWN_DEXTER_MASTER,
      identitySeed: KNOWN_IDENTITY_SEED,
      hmacKey: new Uint8Array(32).fill(0xAB),
    });
    expect(a.swigAddress).not.toBe(b.swigAddress);
  });

  test('SWIG_PROGRAM_EXEC_PREFIX_SETTLE_TAB matches the on-chain settle_tab_voucher discriminator', () => {
    // The bug we are preventing: this marker MUST equal the on-chain Anchor
    // discriminator for settle_tab_voucher. If the program's discriminator
    // ever changes, the marker drifts, and every settle goes to "Role not found".
    expect(SWIG_PROGRAM_EXEC_PREFIX_SETTLE_TAB).toEqual(
      new Uint8Array([173, 22, 98, 31, 110, 129, 59, 161]),
    );
  });

  test('SWIG_PROGRAM_EXEC_PREFIX matches the on-chain finalize_withdrawal discriminator', () => {
    expect(SWIG_PROGRAM_EXEC_PREFIX).toEqual(
      new Uint8Array([178, 87, 206, 68, 201, 186, 164, 232]),
    );
  });

  test('SWIG_PROGRAM_EXEC_MARKERS exports both markers in declared order', () => {
    expect(SWIG_PROGRAM_EXEC_MARKERS.length).toBe(2);
    expect(SWIG_PROGRAM_EXEC_MARKERS[0]).toBe(SWIG_PROGRAM_EXEC_PREFIX);
    expect(SWIG_PROGRAM_EXEC_MARKERS[1]).toBe(SWIG_PROGRAM_EXEC_PREFIX_SETTLE_TAB);
  });

  test('expectedSwigAddressFor matches the bundle output', async () => {
    const bundle = await buildSwigCreationBundle({
      feePayer: KNOWN_FEE_PAYER,
      dexterMasterPubkey: KNOWN_DEXTER_MASTER,
      identitySeed: KNOWN_IDENTITY_SEED,
      hmacKey: KNOWN_HMAC_KEY,
    });
    const expected = await expectedSwigAddressFor(KNOWN_IDENTITY_SEED, KNOWN_HMAC_KEY);
    expect(bundle.swigAddress).toBe(expected);
  });

  test('rejects hmacKey of wrong length', async () => {
    await expect(buildSwigCreationBundle({
      feePayer: KNOWN_FEE_PAYER,
      dexterMasterPubkey: KNOWN_DEXTER_MASTER,
      identitySeed: KNOWN_IDENTITY_SEED,
      hmacKey: new Uint8Array(16),     // wrong: need 32
    })).rejects.toThrow();
  });
});
