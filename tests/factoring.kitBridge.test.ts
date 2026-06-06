import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { kitInstructionsToWeb3 } from '../src/factoring/kitBridge.js';

describe('kitInstructionsToWeb3', () => {
  it('converts a kit instruction (boolean-shape accounts) to a web3 TransactionInstruction', () => {
    const prog = new PublicKey('So11111111111111111111111111111111111111112');
    const acct = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    const kitIx = {
      programAddress: prog.toBase58(),
      accounts: [{ address: acct.toBase58(), signer: true, writable: true }],
      data: new Uint8Array([1, 2, 3]),
    };
    const [web3Ix] = kitInstructionsToWeb3([kitIx]);
    expect(web3Ix.programId.equals(prog)).toBe(true);
    expect(web3Ix.keys.length).toBe(1);
    expect(web3Ix.keys[0].pubkey.equals(acct)).toBe(true);
    expect(web3Ix.keys[0].isSigner).toBe(true);
    expect(web3Ix.keys[0].isWritable).toBe(true);
    expect(Array.from(web3Ix.data)).toEqual([1, 2, 3]);
  });

  it('handles numeric role accounts (role>=2 signer, odd role writable)', () => {
    const prog = new PublicKey('So11111111111111111111111111111111111111112');
    const acct = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    const kitIx = { programAddress: prog.toBase58(), accounts: [{ address: acct.toBase58(), role: 3 }], data: new Uint8Array() };
    const [web3Ix] = kitInstructionsToWeb3([kitIx]);
    expect(web3Ix.keys[0].isSigner).toBe(true);  // role 3 >= 2
    expect(web3Ix.keys[0].isWritable).toBe(true); // role 3 odd
  });
});
