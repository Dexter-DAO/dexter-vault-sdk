/**
 * LockedClaim instruction builders — the claim lifecycle.
 * Mirrors the on-chain Anchor structs in
 * programs/dexter-vault/src/instructions/{lock_voucher,settle_locked_voucher,
 * transfer_lock_ownership,recover_abandoned_lock}.rs. Account ordering is
 * consensus-critical and MUST match the program exactly.
 */
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import {
  DEXTER_VAULT_PROGRAM_ID,
  DISCRIMINATORS,
  INSTRUCTIONS_SYSVAR_ID,
  LOCKED_CLAIM_SEED,
} from '../constants/index.js';
import { deriveSwigWalletAddress } from './withdraw.js';

// ── local encoding helper (per-file convention, matches setSwig.ts) ──
function encodeBytesVec(buf: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(buf.length, 0);
  return Buffer.concat([len, Buffer.from(buf)]);
}

function encodeU64(value: bigint): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(value, 0);
  return out;
}

function encodeU32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value, 0);
  return out;
}

/** Borsh Option<i64>: 0x00 for None, 0x01 || i64-LE for Some. */
function encodeOptionI64(value: bigint | null): Buffer {
  if (value === null) return Buffer.from([0]);
  const out = Buffer.alloc(9);
  out.writeUInt8(1, 0);
  out.writeBigInt64LE(value, 1);
  return out;
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

/** LockedClaim PDA: [LOCKED_CLAIM_SEED, vault, voucher_hash] under the vault program. */
export function deriveLockedClaimPda(vaultPda: PublicKey, voucherHash: Uint8Array): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [LOCKED_CLAIM_SEED, vaultPda.toBuffer(), Buffer.from(voucherHash)],
    DEXTER_VAULT_PROGRAM_ID,
  );
  return pda;
}

// ── lock_voucher ───────────────────────────────────────────────────────────

export interface LockVoucherParams {
  vaultPda: PublicKey;
  vaultUsdcAta: PublicKey;
  swigAddress: PublicKey;
  sellerHolder: PublicKey;
  dexterAuthority: PublicKey;
  payer: PublicKey;
  channelId: Uint8Array;       // 32 bytes
  cumulativeAmount: bigint;
  sequenceNumber: number;
  voucherHash: Uint8Array;     // 32 bytes
  maturityAt: bigint | null;
  holderRecoveryAt: bigint | null;
}

/**
 * Account order MUST match the on-chain struct:
 *   [0] vault               (writable)
 *   [1] vault_usdc_ata      (readonly)
 *   [2] swig                (readonly)
 *   [3] swig_wallet_address (readonly, PDA)
 *   [4] claim               (writable, PDA [LOCKED_CLAIM_SEED, vault, voucher_hash])
 *   [5] seller_holder       (signer)
 *   [6] dexter_authority    (signer)
 *   [7] payer               (signer, writable)
 *   [8] system_program      (readonly)
 *   [9] instructions_sysvar (readonly)
 * Data: disc || channel_id(32) || cumulative(u64) || sequence(u32)
 *       || voucher_hash(32) || option_i64(maturity_at) || option_i64(holder_recovery_at)
 */
export function buildLockVoucherInstruction(p: LockVoucherParams): TransactionInstruction {
  const data = Buffer.concat([
    Buffer.from(DISCRIMINATORS.lock_voucher),
    Buffer.from(p.channelId),
    encodeU64(p.cumulativeAmount),
    encodeU32(p.sequenceNumber),
    Buffer.from(p.voucherHash),
    encodeOptionI64(p.maturityAt),
    encodeOptionI64(p.holderRecoveryAt),
  ]);
  const swigWalletAddress = deriveSwigWalletAddress(p.swigAddress);
  const claimPda = deriveLockedClaimPda(p.vaultPda, p.voucherHash);
  return new TransactionInstruction({
    programId: DEXTER_VAULT_PROGRAM_ID,
    keys: [
      { pubkey: p.vaultPda, isSigner: false, isWritable: true },
      { pubkey: p.vaultUsdcAta, isSigner: false, isWritable: false },
      { pubkey: p.swigAddress, isSigner: false, isWritable: false },
      { pubkey: swigWalletAddress, isSigner: false, isWritable: false },
      { pubkey: claimPda, isSigner: false, isWritable: true },
      { pubkey: p.sellerHolder, isSigner: true, isWritable: false },
      { pubkey: p.dexterAuthority, isSigner: true, isWritable: false },
      { pubkey: p.payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: INSTRUCTIONS_SYSVAR_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}
