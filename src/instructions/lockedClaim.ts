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
import { deriveSessionPda } from '../session/index.js';
import { deriveSwigWalletAddress } from './withdraw.js';
import { deriveGraphConfigPda } from '../credit/derive.js';

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
 *   [5] dexter_authority    (signer, writable — close = dexter_authority reclaims claim rent)
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
      { pubkey: p.dexterAuthority, isSigner: true, isWritable: true },
      // instructions_sysvar [6] + graph_config [7] — added 2026-07-02 with the
      // money-leg bind (settle_locked now decodes + binds the following transfer).
      { pubkey: INSTRUCTIONS_SYSVAR_ID, isSigner: false, isWritable: false },
      { pubkey: deriveGraphConfigPda()[0], isSigner: false, isWritable: false },
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

// ── close_locked_claim ─────────────────────────────────────────────────────

export interface CloseLockedClaimParams {
  vaultPda: PublicKey;
  claimPda: PublicKey;
  dexterAuthority: PublicKey;
}

/**
 * Account order MUST match the on-chain struct (CloseLockedClaim):
 *   [0] vault            (readonly — has_one dexter_authority)
 *   [1] claim            (writable — closed, rent drained to dexter_authority)
 *   [2] dexter_authority (signer, writable — receives reclaimed rent)
 * Data: discriminator only (CloseLockedClaimArgs is empty).
 */
export function buildCloseLockedClaimInstruction(
  p: CloseLockedClaimParams,
): TransactionInstruction {
  const data = Buffer.from(DISCRIMINATORS.close_locked_claim);
  return new TransactionInstruction({
    programId: DEXTER_VAULT_PROGRAM_ID,
    keys: [
      { pubkey: p.vaultPda, isSigner: false, isWritable: false },
      { pubkey: p.claimPda, isSigner: false, isWritable: true },
      { pubkey: p.dexterAuthority, isSigner: true, isWritable: true },
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
  /** V6: the seller this voucher pays — names the session PDA (seed) and is
   *  the LAST Borsh arg (after the variable-length Option<i64> fields). */
  allowedCounterparty: PublicKey;
  channelId: Uint8Array;       // 32 bytes
  cumulativeAmount: bigint;
  sequenceNumber: number;
  voucherHash: Uint8Array;     // 32 bytes
  maturityAt: bigint | null;
  holderRecoveryAt: bigint | null;
}

/**
 * Account order MUST match the on-chain struct (V6, 11 accounts):
 *   [0]  vault               (writable)
 *   [1]  vault_usdc_ata      (readonly)
 *   [2]  swig                (readonly)
 *   [3]  swig_wallet_address (readonly, PDA)
 *   [4]  session             (writable, PDA [b"session", vault, allowed_counterparty])
 *   [5]  claim               (writable, PDA [LOCKED_CLAIM_SEED, vault, voucher_hash])
 *   [6]  seller_holder       (signer)
 *   [7]  dexter_authority    (signer)
 *   [8]  payer               (signer, writable)
 *   [9]  system_program      (readonly)
 *   [10] instructions_sysvar (readonly)
 * Data: disc || channel_id(32) || cumulative(u64) || sequence(u32)
 *       || voucher_hash(32) || option_i64(maturity_at) || option_i64(holder_recovery_at)
 *       || allowed_counterparty(32)
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
    p.allowedCounterparty.toBuffer(),
  ]);
  const swigWalletAddress = deriveSwigWalletAddress(p.swigAddress);
  const [sessionPda] = deriveSessionPda(p.vaultPda, p.allowedCounterparty);
  const claimPda = deriveLockedClaimPda(p.vaultPda, p.voucherHash);
  return new TransactionInstruction({
    programId: DEXTER_VAULT_PROGRAM_ID,
    keys: [
      { pubkey: p.vaultPda, isSigner: false, isWritable: true },
      { pubkey: p.vaultUsdcAta, isSigner: false, isWritable: false },
      { pubkey: p.swigAddress, isSigner: false, isWritable: false },
      { pubkey: swigWalletAddress, isSigner: false, isWritable: false },
      { pubkey: sessionPda, isSigner: false, isWritable: true },
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
