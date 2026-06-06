import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { buildTransferLockOwnershipInstruction } from '../src/instructions/lockedClaim.js';
import { DEXTER_VAULT_PROGRAM_ID, DISCRIMINATORS } from '../src/constants/index.js';

const CLAIM = new PublicKey('11111111111111111111111111111111');
const HOLDER = new PublicKey('So11111111111111111111111111111111111111112');
const NEW_HOLDER = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

describe('transferLockOwnership', () => {
  it('emits 2 accounts in canonical order with the right discriminator', () => {
    const ix = buildTransferLockOwnershipInstruction({
      claimPda: CLAIM,
      currentHolder: HOLDER,
      newHolder: NEW_HOLDER,
    });
    expect(ix.programId.equals(DEXTER_VAULT_PROGRAM_ID)).toBe(true);
    expect(ix.keys.length).toBe(2);
    expect(ix.keys[0].pubkey.equals(CLAIM)).toBe(true);
    expect(ix.keys[0].isWritable).toBe(true);
    expect(ix.keys[0].isSigner).toBe(false);
    expect(ix.keys[1].pubkey.equals(HOLDER)).toBe(true);
    expect(ix.keys[1].isSigner).toBe(true);
    expect(ix.keys[1].isWritable).toBe(false);
    expect(ix.data.length).toBe(40);
    expect(Buffer.from(ix.data.subarray(0, 8))).toEqual(Buffer.from(DISCRIMINATORS.transfer_lock_ownership));
    expect(Buffer.from(ix.data.subarray(8, 40))).toEqual(NEW_HOLDER.toBuffer());
  });
});
