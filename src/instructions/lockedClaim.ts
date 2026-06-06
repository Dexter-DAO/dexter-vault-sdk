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
import { deriveSwigWalletAddress } from './withdraw.js';

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

// ── settle_locked_voucher ──────────────────────────────────────────────────

export interface SettleLockedVoucherParams {
  swigAddress: PublicKey;
  claimPda: PublicKey;
  vaultPda: PublicKey;
  holder: PublicKey;
  dexterAuthority: PublicKey;
}

/**
 * Account order MUST match the on-chain struct:
 *   [0] swig                (readonly, == vault.swig_address)
 *   [1] swig_wallet_address (readonly, PDA derived from swig)
 *   [2] claim               (writable)
 *   [3] vault               (writable)
 *   [4] holder              (signer — the current claim holder collecting)
 *   [5] dexter_authority    (signer)
 * Data: discriminator only (SettleLockedVoucherArgs is empty).
 */
export function buildSettleLockedVoucherInstruction(
  p: SettleLockedVoucherParams,
): TransactionInstruction {
  const data = Buffer.from(DISCRIMINATORS.settle_locked_voucher);
  const swigWalletAddress = deriveSwigWalletAddress(p.swigAddress);
  return new TransactionInstruction({
    programId: DEXTER_VAULT_PROGRAM_ID,
    keys: [
      { pubkey: p.swigAddress, isSigner: false, isWritable: false },
      { pubkey: swigWalletAddress, isSigner: false, isWritable: false },
      { pubkey: p.claimPda, isSigner: false, isWritable: true },
      { pubkey: p.vaultPda, isSigner: false, isWritable: true },
      { pubkey: p.holder, isSigner: true, isWritable: false },
      { pubkey: p.dexterAuthority, isSigner: true, isWritable: false },
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
