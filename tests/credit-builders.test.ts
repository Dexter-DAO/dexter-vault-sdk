import { describe, it, expect } from 'vitest';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import {
  buildOpenStandbyInstruction,
  buildSetStandbyReserveInstruction,
  deriveStandbyBackerPda,
} from '../src/instructions/credit.js';
import { deriveSwigWalletAddress } from '../src/instructions/withdraw.js';
import { DISCRIMINATORS, INSTRUCTIONS_SYSVAR_ID } from '../src/constants/index.js';

const FIN = new PublicKey('11111111111111111111111111111112');
const VAULT = new PublicKey('11111111111111111111111111111113');

describe('buildOpenStandbyInstruction (Phase-1 reserve account)', () => {
  it('includes standby_backer at index 2, sysvar at index 3', () => {
    const ix = buildOpenStandbyInstruction({
      vaultPda: VAULT, financierSwig: FIN, cap: 5_000_000n,
      clientDataJSON: new Uint8Array([1]), authenticatorData: new Uint8Array([2]),
    });
    const backer = deriveStandbyBackerPda(FIN);
    expect(ix.keys.length).toBe(4);
    expect(ix.keys[0].pubkey.equals(VAULT)).toBe(true);
    expect(ix.keys[1].pubkey.equals(FIN)).toBe(true);
    expect(ix.keys[2].pubkey.equals(backer)).toBe(true);
    expect(ix.keys[2].isWritable).toBe(true);
    expect(ix.keys[3].pubkey.equals(INSTRUCTIONS_SYSVAR_ID)).toBe(true);
  });
});

describe('buildSetStandbyReserveInstruction (mechanism B)', () => {
  it('correct accounts + financier_swig_wallet is a SIGNER + no sysvar', () => {
    const FEE = new PublicKey('11111111111111111111111111111114');
    const ix = buildSetStandbyReserveInstruction({
      financierSwig: FIN, feePayer: FEE, newReserve: 10_000_000n,
    });
    const wallet = deriveSwigWalletAddress(FIN);
    const backer = deriveStandbyBackerPda(FIN);
    expect(ix.keys.length).toBe(5);
    expect(Buffer.from(ix.data.subarray(0,8))).toEqual(Buffer.from(DISCRIMINATORS.set_standby_reserve));
    expect(ix.keys[0].pubkey.equals(FIN)).toBe(true);
    expect(ix.keys[1].pubkey.equals(wallet)).toBe(true);
    expect(ix.keys[1].isSigner).toBe(true);
    expect(ix.keys[2].pubkey.equals(backer)).toBe(true);
    expect(ix.keys[2].isWritable).toBe(true);
    expect(ix.keys[3].pubkey.equals(FEE)).toBe(true);
    expect(ix.keys[3].isSigner).toBe(true);
    expect(ix.keys[3].isWritable).toBe(true);
    expect(ix.keys[4].pubkey.equals(SystemProgram.programId)).toBe(true);
    expect(ix.keys.some(k => k.pubkey.equals(INSTRUCTIONS_SYSVAR_ID))).toBe(false);
    expect(ix.data.length).toBe(16); // 8 disc + 8 u64
  });
});
