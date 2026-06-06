/**
 * Credit-L2 instruction builders — the standby-credit lifecycle.
 * Mirrors the on-chain Anchor structs in
 * programs/dexter-vault/src/instructions/{open_standby,draw_credit,repay_credit,
 * seize_collateral,migrate_v4_to_v5}.rs. Account ordering is consensus-critical
 * and MUST match the program exactly.
 */
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import {
  DEXTER_VAULT_PROGRAM_ID,
  DISCRIMINATORS,
  INSTRUCTIONS_SYSVAR_ID,
} from '../constants/index.js';
import { deriveSwigWalletAddress } from './withdraw.js';

// ── local encoding helpers (per-file convention, matches lockedClaim.ts) ──
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

function encodeI64(value: bigint): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigInt64LE(value, 0);
  return out;
}

// ── open_standby ───────────────────────────────────────────────────────────

export interface OpenStandbyParams {
  vaultPda: PublicKey;
  financierSwig: PublicKey;
  cap: bigint;
  clientDataJSON: Uint8Array;
  authenticatorData: Uint8Array;
}

/**
 * Account order MUST match the on-chain struct:
 *   [0] vault               (writable)
 *   [1] financier_swig      (readonly)
 *   [2] instructions_sysvar (readonly)
 * Data: disc || cap(u64) || vec(client_data_json) || vec(authenticator_data).
 */
export function buildOpenStandbyInstruction(p: OpenStandbyParams): TransactionInstruction {
  const data = Buffer.concat([
    Buffer.from(DISCRIMINATORS.open_standby),
    encodeU64(p.cap),
    encodeBytesVec(p.clientDataJSON),
    encodeBytesVec(p.authenticatorData),
  ]);
  return new TransactionInstruction({
    programId: DEXTER_VAULT_PROGRAM_ID,
    keys: [
      { pubkey: p.vaultPda, isSigner: false, isWritable: true },
      { pubkey: p.financierSwig, isSigner: false, isWritable: false },
      { pubkey: INSTRUCTIONS_SYSVAR_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ── draw_credit ────────────────────────────────────────────────────────────

export interface DrawCreditParams {
  financierSwig: PublicKey;
  vaultPda: PublicKey;
  dexterAuthority: PublicKey;
  amount: bigint;
  recoveryWindowSeconds: bigint;
}

/**
 * Account order MUST match the on-chain struct:
 *   [0] financier_swig                (readonly)
 *   [1] financier_swig_wallet_address (readonly, PDA derived from financier_swig)
 *   [2] vault                         (writable)
 *   [3] dexter_authority              (signer)
 *   [4] instructions_sysvar           (readonly)
 * Data: disc || amount(u64) || recovery_window_seconds(i64).
 */
export function buildDrawCreditInstruction(p: DrawCreditParams): TransactionInstruction {
  const data = Buffer.concat([
    Buffer.from(DISCRIMINATORS.draw_credit),
    encodeU64(p.amount),
    encodeI64(p.recoveryWindowSeconds),
  ]);
  const financierSwigWalletAddress = deriveSwigWalletAddress(p.financierSwig);
  return new TransactionInstruction({
    programId: DEXTER_VAULT_PROGRAM_ID,
    keys: [
      { pubkey: p.financierSwig, isSigner: false, isWritable: false },
      { pubkey: financierSwigWalletAddress, isSigner: false, isWritable: false },
      { pubkey: p.vaultPda, isSigner: false, isWritable: true },
      { pubkey: p.dexterAuthority, isSigner: true, isWritable: false },
      { pubkey: INSTRUCTIONS_SYSVAR_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ── repay_credit ───────────────────────────────────────────────────────────

export interface RepayCreditParams {
  swigAddress: PublicKey;
  vaultPda: PublicKey;
  dexterAuthority: PublicKey;
  amount: bigint;
}

/**
 * Account order MUST match the on-chain struct:
 *   [0] swig                (readonly, the USER's swig)
 *   [1] swig_wallet_address (readonly, PDA derived from swig)
 *   [2] vault               (writable)
 *   [3] dexter_authority    (signer)
 *   [4] instructions_sysvar (readonly)
 * Data: disc || amount(u64).
 */
export function buildRepayCreditInstruction(p: RepayCreditParams): TransactionInstruction {
  const data = Buffer.concat([
    Buffer.from(DISCRIMINATORS.repay_credit),
    encodeU64(p.amount),
  ]);
  const swigWalletAddress = deriveSwigWalletAddress(p.swigAddress);
  return new TransactionInstruction({
    programId: DEXTER_VAULT_PROGRAM_ID,
    keys: [
      { pubkey: p.swigAddress, isSigner: false, isWritable: false },
      { pubkey: swigWalletAddress, isSigner: false, isWritable: false },
      { pubkey: p.vaultPda, isSigner: false, isWritable: true },
      { pubkey: p.dexterAuthority, isSigner: true, isWritable: false },
      { pubkey: INSTRUCTIONS_SYSVAR_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ── seize_collateral ───────────────────────────────────────────────────────

export interface SeizeCollateralParams {
  swigAddress: PublicKey;
  vaultPda: PublicKey;
  dexterAuthority: PublicKey;
}

/**
 * Account order MUST match the on-chain struct:
 *   [0] swig                (readonly, the USER's swig)
 *   [1] swig_wallet_address (readonly, PDA derived from swig)
 *   [2] vault               (writable)
 *   [3] dexter_authority    (signer)
 *   [4] instructions_sysvar (readonly)
 * Data: discriminator only (SeizeCollateralArgs is empty).
 */
export function buildSeizeCollateralInstruction(p: SeizeCollateralParams): TransactionInstruction {
  const data = Buffer.from(DISCRIMINATORS.seize_collateral);
  const swigWalletAddress = deriveSwigWalletAddress(p.swigAddress);
  return new TransactionInstruction({
    programId: DEXTER_VAULT_PROGRAM_ID,
    keys: [
      { pubkey: p.swigAddress, isSigner: false, isWritable: false },
      { pubkey: swigWalletAddress, isSigner: false, isWritable: false },
      { pubkey: p.vaultPda, isSigner: false, isWritable: true },
      { pubkey: p.dexterAuthority, isSigner: true, isWritable: false },
      { pubkey: INSTRUCTIONS_SYSVAR_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ── migrate_v4_to_v5 ───────────────────────────────────────────────────────

export interface MigrateV4ToV5Params {
  vaultPda: PublicKey;
  dexterAuthority: PublicKey;
  payer: PublicKey;
}

/**
 * Account order MUST match the on-chain struct:
 *   [0] vault          (writable, AccountInfo validated in-handler)
 *   [1] dexter_authority (signer)
 *   [2] payer          (signer, writable)
 *   [3] system_program (readonly)
 * Data: discriminator only (MigrateV4ToV5Args is empty).
 */
export function buildMigrateV4ToV5Instruction(p: MigrateV4ToV5Params): TransactionInstruction {
  const data = Buffer.from(DISCRIMINATORS.migrate_v4_to_v5);
  return new TransactionInstruction({
    programId: DEXTER_VAULT_PROGRAM_ID,
    keys: [
      { pubkey: p.vaultPda, isSigner: false, isWritable: true },
      { pubkey: p.dexterAuthority, isSigner: true, isWritable: false },
      { pubkey: p.payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}
