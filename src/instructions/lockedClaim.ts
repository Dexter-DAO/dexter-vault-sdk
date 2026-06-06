/**
 * LockedClaim instruction builders — the claim lifecycle.
 * Mirrors the on-chain Anchor structs in
 * programs/dexter-vault/src/instructions/{lock_voucher,settle_locked_voucher,
 * transfer_lock_ownership,recover_abandoned_lock}.rs. Account ordering is
 * consensus-critical and MUST match the program exactly.
 */
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import {
  DEXTER_VAULT_PROGRAM_ID,
  DISCRIMINATORS,
  INSTRUCTIONS_SYSVAR_ID,
} from '../constants/index.js';

// ── local encoding helper (per-file convention, matches setSwig.ts) ──
function encodeBytesVec(buf: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(buf.length, 0);
  return Buffer.concat([len, Buffer.from(buf)]);
}

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

// ── recover_abandoned_lock ─────────────────────────────────────────────────

export interface RecoverAbandonedLockParams {
  claimPda: PublicKey;
  vaultPda: PublicKey;
  clientDataJSON: Uint8Array;
  authenticatorData: Uint8Array;
}

/**
 * Account order MUST match the on-chain struct:
 *   [0] claim               (writable)
 *   [1] vault               (writable)
 *   [2] instructions_sysvar (readonly)
 * Data: discriminator || vec(client_data_json) || vec(authenticator_data).
 */
export function buildRecoverAbandonedLockInstruction(
  p: RecoverAbandonedLockParams,
): TransactionInstruction {
  const data = Buffer.concat([
    Buffer.from(DISCRIMINATORS.recover_abandoned_lock),
    encodeBytesVec(p.clientDataJSON),
    encodeBytesVec(p.authenticatorData),
  ]);
  return new TransactionInstruction({
    programId: DEXTER_VAULT_PROGRAM_ID,
    keys: [
      { pubkey: p.claimPda, isSigner: false, isWritable: true },
      { pubkey: p.vaultPda, isSigner: false, isWritable: true },
      { pubkey: INSTRUCTIONS_SYSVAR_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}
