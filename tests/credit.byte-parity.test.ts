import { describe, it, expect } from 'vitest';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import {
  buildOpenStandbyInstruction,
  buildDrawCreditInstruction,
  buildRepayCreditInstruction,
  buildSeizeCollateralInstruction,
  buildMigrateV4ToV5Instruction,
} from '../src/instructions/credit.js';
import { deriveSwigWalletAddress } from '../src/instructions/withdraw.js';
import { DEXTER_VAULT_PROGRAM_ID, DISCRIMINATORS, INSTRUCTIONS_SYSVAR_ID } from '../src/constants/index.js';

// Distinct valid base58 pubkeys so positional assertions stay unambiguous.
const RENT = new PublicKey('SysvarRent111111111111111111111111111111111');
const CLOCK = new PublicKey('SysvarC1ock11111111111111111111111111111111');
const WSOL = new PublicKey('So11111111111111111111111111111111111111112');
const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const SYSTEM = new PublicKey('11111111111111111111111111111111');

describe('openStandby', () => {
  it('emits 3 accounts in canonical order with u64 cap + two byte-vec args', () => {
    const clientDataJSON = new Uint8Array([1, 2, 3]);
    const authenticatorData = new Uint8Array([4, 5, 6, 7]);
    const ix = buildOpenStandbyInstruction({
      vaultPda: RENT,
      financierSwig: CLOCK,
      cap: 5_000_000n,
      clientDataJSON,
      authenticatorData,
    });
    expect(ix.programId.equals(DEXTER_VAULT_PROGRAM_ID)).toBe(true);
    expect(ix.keys.length).toBe(3);
    // [0] vault (writable, not signer)
    expect(ix.keys[0].pubkey.equals(RENT)).toBe(true);
    expect(ix.keys[0].isWritable).toBe(true);
    expect(ix.keys[0].isSigner).toBe(false);
    // [1] financier_swig (readonly, not signer)
    expect(ix.keys[1].pubkey.equals(CLOCK)).toBe(true);
    expect(ix.keys[1].isWritable).toBe(false);
    expect(ix.keys[1].isSigner).toBe(false);
    // [2] instructions_sysvar (readonly)
    expect(ix.keys[2].pubkey.equals(INSTRUCTIONS_SYSVAR_ID)).toBe(true);
    expect(ix.keys[2].isWritable).toBe(false);
    expect(ix.keys[2].isSigner).toBe(false);
    // data: disc(8) + cap u64(8) + (len4+3) + (len4+4) = 8 + 8 + 7 + 8 = 31
    expect(ix.data.length).toBe(31);
    expect(Buffer.from(ix.data.subarray(0, 8))).toEqual(Buffer.from(DISCRIMINATORS.open_standby));
    // cap u64 at [8,16)
    expect(ix.data.readBigUInt64LE(8)).toBe(5_000_000n);
    // client_data_json vec: len prefix 3 at [16], then [1,2,3] at [20,23)
    expect(ix.data.readUInt32LE(16)).toBe(3);
    expect(Array.from(ix.data.subarray(20, 23))).toEqual([1, 2, 3]);
    // authenticator_data vec: len prefix 4 at [23], then [4,5,6,7] at [27,31)
    expect(ix.data.readUInt32LE(23)).toBe(4);
    expect(Array.from(ix.data.subarray(27, 31))).toEqual([4, 5, 6, 7]);
  });
});

describe('drawCredit', () => {
  it('emits 5 accounts in canonical order with u64 amount + i64 recovery window', () => {
    const ix = buildDrawCreditInstruction({
      financierSwig: RENT,
      vaultPda: CLOCK,
      dexterAuthority: WSOL,
      amount: 2_500_000n,
      recoveryWindowSeconds: 86_400n,
    });
    expect(ix.programId.equals(DEXTER_VAULT_PROGRAM_ID)).toBe(true);
    expect(ix.keys.length).toBe(5);
    // [0] financier_swig (readonly, not signer)
    expect(ix.keys[0].pubkey.equals(RENT)).toBe(true);
    expect(ix.keys[0].isWritable).toBe(false);
    expect(ix.keys[0].isSigner).toBe(false);
    // [1] financier_swig_wallet_address (readonly, derived)
    expect(ix.keys[1].pubkey.equals(deriveSwigWalletAddress(RENT))).toBe(true);
    expect(ix.keys[1].isWritable).toBe(false);
    expect(ix.keys[1].isSigner).toBe(false);
    // [2] vault (writable)
    expect(ix.keys[2].pubkey.equals(CLOCK)).toBe(true);
    expect(ix.keys[2].isWritable).toBe(true);
    expect(ix.keys[2].isSigner).toBe(false);
    // [3] dexter_authority (signer, not writable)
    expect(ix.keys[3].pubkey.equals(WSOL)).toBe(true);
    expect(ix.keys[3].isSigner).toBe(true);
    expect(ix.keys[3].isWritable).toBe(false);
    // [4] instructions_sysvar (readonly)
    expect(ix.keys[4].pubkey.equals(INSTRUCTIONS_SYSVAR_ID)).toBe(true);
    expect(ix.keys[4].isWritable).toBe(false);
    expect(ix.keys[4].isSigner).toBe(false);
    // data: disc(8) + amount u64(8) + recovery i64(8) = 24
    expect(ix.data.length).toBe(24);
    expect(Buffer.from(ix.data.subarray(0, 8))).toEqual(Buffer.from(DISCRIMINATORS.draw_credit));
    expect(ix.data.readBigUInt64LE(8)).toBe(2_500_000n);
    expect(ix.data.readBigInt64LE(16)).toBe(86_400n);
  });
});

describe('repayCredit', () => {
  it('emits 5 accounts in canonical order with a single u64 amount arg', () => {
    const ix = buildRepayCreditInstruction({
      swigAddress: RENT,
      vaultPda: CLOCK,
      dexterAuthority: WSOL,
      amount: 1_000_000n,
    });
    expect(ix.programId.equals(DEXTER_VAULT_PROGRAM_ID)).toBe(true);
    expect(ix.keys.length).toBe(5);
    // [0] swig (readonly, not signer)
    expect(ix.keys[0].pubkey.equals(RENT)).toBe(true);
    expect(ix.keys[0].isWritable).toBe(false);
    expect(ix.keys[0].isSigner).toBe(false);
    // [1] swig_wallet_address (readonly, derived)
    expect(ix.keys[1].pubkey.equals(deriveSwigWalletAddress(RENT))).toBe(true);
    expect(ix.keys[1].isWritable).toBe(false);
    expect(ix.keys[1].isSigner).toBe(false);
    // [2] vault (writable)
    expect(ix.keys[2].pubkey.equals(CLOCK)).toBe(true);
    expect(ix.keys[2].isWritable).toBe(true);
    expect(ix.keys[2].isSigner).toBe(false);
    // [3] dexter_authority (signer, not writable)
    expect(ix.keys[3].pubkey.equals(WSOL)).toBe(true);
    expect(ix.keys[3].isSigner).toBe(true);
    expect(ix.keys[3].isWritable).toBe(false);
    // [4] instructions_sysvar (readonly)
    expect(ix.keys[4].pubkey.equals(INSTRUCTIONS_SYSVAR_ID)).toBe(true);
    expect(ix.keys[4].isWritable).toBe(false);
    expect(ix.keys[4].isSigner).toBe(false);
    // data: disc(8) + amount u64(8) = 16
    expect(ix.data.length).toBe(16);
    expect(Buffer.from(ix.data.subarray(0, 8))).toEqual(Buffer.from(DISCRIMINATORS.repay_credit));
    expect(ix.data.readBigUInt64LE(8)).toBe(1_000_000n);
  });
});

describe('seizeCollateral', () => {
  it('emits 5 accounts in canonical order, empty args (discriminator only)', () => {
    const ix = buildSeizeCollateralInstruction({
      swigAddress: RENT,
      vaultPda: CLOCK,
      dexterAuthority: WSOL,
    });
    expect(ix.programId.equals(DEXTER_VAULT_PROGRAM_ID)).toBe(true);
    expect(ix.keys.length).toBe(5);
    // [0] swig (readonly, not signer)
    expect(ix.keys[0].pubkey.equals(RENT)).toBe(true);
    expect(ix.keys[0].isWritable).toBe(false);
    expect(ix.keys[0].isSigner).toBe(false);
    // [1] swig_wallet_address (readonly, derived)
    expect(ix.keys[1].pubkey.equals(deriveSwigWalletAddress(RENT))).toBe(true);
    expect(ix.keys[1].isWritable).toBe(false);
    expect(ix.keys[1].isSigner).toBe(false);
    // [2] vault (writable)
    expect(ix.keys[2].pubkey.equals(CLOCK)).toBe(true);
    expect(ix.keys[2].isWritable).toBe(true);
    expect(ix.keys[2].isSigner).toBe(false);
    // [3] dexter_authority (signer, not writable)
    expect(ix.keys[3].pubkey.equals(WSOL)).toBe(true);
    expect(ix.keys[3].isSigner).toBe(true);
    expect(ix.keys[3].isWritable).toBe(false);
    // [4] instructions_sysvar (readonly)
    expect(ix.keys[4].pubkey.equals(INSTRUCTIONS_SYSVAR_ID)).toBe(true);
    expect(ix.keys[4].isWritable).toBe(false);
    expect(ix.keys[4].isSigner).toBe(false);
    // data: disc(8) only
    expect(ix.data.length).toBe(8);
    expect(Buffer.from(ix.data)).toEqual(Buffer.from(DISCRIMINATORS.seize_collateral));
  });
});

describe('migrateV4ToV5', () => {
  it('emits 4 accounts in canonical order, empty args (discriminator only)', () => {
    const ix = buildMigrateV4ToV5Instruction({
      vaultPda: RENT,
      dexterAuthority: CLOCK,
      payer: WSOL,
    });
    expect(ix.programId.equals(DEXTER_VAULT_PROGRAM_ID)).toBe(true);
    expect(ix.keys.length).toBe(4);
    // [0] vault (writable, not signer)
    expect(ix.keys[0].pubkey.equals(RENT)).toBe(true);
    expect(ix.keys[0].isWritable).toBe(true);
    expect(ix.keys[0].isSigner).toBe(false);
    // [1] dexter_authority (signer, not writable)
    expect(ix.keys[1].pubkey.equals(CLOCK)).toBe(true);
    expect(ix.keys[1].isSigner).toBe(true);
    expect(ix.keys[1].isWritable).toBe(false);
    // [2] payer (signer, writable)
    expect(ix.keys[2].pubkey.equals(WSOL)).toBe(true);
    expect(ix.keys[2].isSigner).toBe(true);
    expect(ix.keys[2].isWritable).toBe(true);
    // [3] system_program (readonly)
    expect(ix.keys[3].pubkey.equals(SystemProgram.programId)).toBe(true);
    expect(ix.keys[3].isWritable).toBe(false);
    expect(ix.keys[3].isSigner).toBe(false);
    // data: disc(8) only
    expect(ix.data.length).toBe(8);
    expect(Buffer.from(ix.data)).toEqual(Buffer.from(DISCRIMINATORS.migrate_v4_to_v5));
  });
});
