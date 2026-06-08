import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { buildOpenStandbyInstruction, deriveStandbyBackerPda } from '../src/instructions/credit.js';
import { INSTRUCTIONS_SYSVAR_ID } from '../src/constants/index.js';

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
