import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { buildTransferLockOwnershipInstruction } from '../src/instructions/lockedClaim.js';
import { buildRecoverAbandonedLockInstruction } from '../src/instructions/lockedClaim.js';
import { buildSettleLockedVoucherInstruction } from '../src/instructions/lockedClaim.js';
import { deriveSwigWalletAddress } from '../src/instructions/withdraw.js';
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

describe('settleLockedVoucher', () => {
  it('emits 6 accounts in canonical order, empty args (discriminator only)', () => {
    // Distinct valid base58 pubkeys — avoid collision with HOLDER (So11..112)
    // and NEW_HOLDER (EPjF..Dt1v) so positional assertions stay unambiguous.
    const SWIG = new PublicKey('SysvarRent111111111111111111111111111111111');
    const VAULT = new PublicKey('SysvarC1ock11111111111111111111111111111111');
    const ix = buildSettleLockedVoucherInstruction({
      swigAddress: SWIG,
      claimPda: CLAIM,
      vaultPda: VAULT,
      holder: HOLDER,
      dexterAuthority: NEW_HOLDER,
    });
    expect(ix.keys.length).toBe(6);
    expect(ix.keys[0].pubkey.equals(SWIG)).toBe(true);
    expect(ix.keys[0].isWritable).toBe(false);
    expect(ix.keys[1].pubkey.equals(deriveSwigWalletAddress(SWIG))).toBe(true);
    expect(ix.keys[1].isWritable).toBe(false);
    expect(ix.keys[2].pubkey.equals(CLAIM)).toBe(true);
    expect(ix.keys[2].isWritable).toBe(true);
    expect(ix.keys[3].pubkey.equals(VAULT)).toBe(true);
    expect(ix.keys[3].isWritable).toBe(true);
    expect(ix.keys[4].pubkey.equals(HOLDER)).toBe(true);
    expect(ix.keys[4].isSigner).toBe(true);
    expect(ix.keys[5].pubkey.equals(NEW_HOLDER)).toBe(true);
    expect(ix.keys[5].isSigner).toBe(true);
    expect(ix.data.length).toBe(8); // discriminator only
    expect(Buffer.from(ix.data)).toEqual(Buffer.from(DISCRIMINATORS.settle_locked_voucher));
  });
});

describe('recoverAbandonedLock', () => {
  it('emits 3 accounts and length-prefixed byte-vec args', () => {
    const VAULT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    const clientDataJSON = new Uint8Array([1, 2, 3]);
    const authenticatorData = new Uint8Array([4, 5, 6, 7]);
    const ix = buildRecoverAbandonedLockInstruction({
      claimPda: CLAIM,
      vaultPda: VAULT,
      clientDataJSON,
      authenticatorData,
    });
    expect(ix.keys.length).toBe(3);
    expect(ix.keys[0].pubkey.equals(CLAIM)).toBe(true);
    expect(ix.keys[0].isWritable).toBe(true);
    expect(ix.keys[0].isSigner).toBe(false);
    expect(ix.keys[1].pubkey.equals(VAULT)).toBe(true);
    expect(ix.keys[1].isWritable).toBe(true);
    expect(ix.keys[2].isWritable).toBe(false); // instructions_sysvar
    expect(ix.keys[2].isSigner).toBe(false);
    // disc(8) + (len4+3) + (len4+4) = 8 + 7 + 8 = 23
    expect(ix.data.length).toBe(23);
    expect(Buffer.from(ix.data.subarray(0, 8))).toEqual(Buffer.from(DISCRIMINATORS.recover_abandoned_lock));
    // client_data_json vec: length prefix 3, then [1,2,3]
    expect(ix.data.readUInt32LE(8)).toBe(3);
    expect(Array.from(ix.data.subarray(12, 15))).toEqual([1, 2, 3]);
    // authenticator_data vec: length prefix 4, then [4,5,6,7]
    expect(ix.data.readUInt32LE(15)).toBe(4);
    expect(Array.from(ix.data.subarray(19, 23))).toEqual([4, 5, 6, 7]);
  });
});
