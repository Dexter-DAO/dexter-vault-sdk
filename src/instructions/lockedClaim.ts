/**
 * LockedClaim instruction builders — the claim lifecycle.
 * Mirrors the on-chain Anchor structs in
 * programs/dexter-vault/src/instructions/{lock_voucher,settle_locked_voucher,
 * transfer_lock_ownership,recover_abandoned_lock}.rs. Account ordering is
 * consensus-critical and MUST match the program exactly.
 */
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { DEXTER_VAULT_PROGRAM_ID, DISCRIMINATORS } from '../constants/index.js';

// ── transfer_lock_ownership ────────────────────────────────────────────────

export interface TransferLockOwnershipParams {
  claimPda: PublicKey;
  currentHolder: PublicKey;
  newHolder: PublicKey;
}

/**
 * Account order MUST match the on-chain struct:
 *   [0] claim          (writable)
 *   [1] current_holder (signer)
 * Data: discriminator || new_holder (32-byte pubkey).
 */
export function buildTransferLockOwnershipInstruction(
  p: TransferLockOwnershipParams,
): TransactionInstruction {
  const data = Buffer.concat([
    Buffer.from(DISCRIMINATORS.transfer_lock_ownership),
    p.newHolder.toBuffer(),
  ]);
  return new TransactionInstruction({
    programId: DEXTER_VAULT_PROGRAM_ID,
    keys: [
      { pubkey: p.claimPda, isSigner: false, isWritable: true },
      { pubkey: p.currentHolder, isSigner: true, isWritable: false },
    ],
    data,
  });
}
