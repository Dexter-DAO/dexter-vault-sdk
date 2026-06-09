/**
 * settle_tab_voucher — Tab streaming settlement; the vault verifies the
 * session-key signature (via an Ed25519 precompile sibling) and then drives
 * the Swig transfer via its role-3 ProgramExec authority.
 *
 * V6 multi-session layout: the per-counterparty SessionAccount PDA is
 * inserted at index 3 (writable) so the program can verify the session
 * signature and bump that session's meter.
 *
 * Account ordering MUST match the on-chain Anchor struct:
 *   [0] swig                  — required by Swig's ProgramExec validator
 *   [1] swig_wallet_address   — canonical PDA under the Swig program
 *   [2] vault                 — the vault PDA being mutated
 *   [3] session               — SessionAccount PDA
 *                               [b"session", vault, allowed_counterparty] (writable)
 *   [4] dexter_authority      — signer; must equal vault.dexter_authority
 *   [5] instructions_sysvar   — for the Ed25519 precompile sibling lookup
 *
 * Args (Borsh after the 8-byte discriminator):
 *   channel_id: [u8; 32]
 *   cumulative_amount: u64
 *   sequence_number: u32
 *   allowed_counterparty: Pubkey (32 bytes, appended LAST)
 */

import {
  PublicKey,
  TransactionInstruction,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from '@solana/web3.js';

import { DEXTER_VAULT_PROGRAM_ID, DISCRIMINATORS } from '../constants/index.js';
import { deriveSessionPda } from '../session/index.js';
import { deriveSwigWalletAddress } from './withdraw.js';

function encodeFixedBytes(buf: Uint8Array, len: number): Buffer {
  if (buf.length !== len) {
    throw new Error(`expected ${len} bytes, got ${buf.length}`);
  }
  return Buffer.from(buf);
}

function encodeU64(value: bigint): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(value, 0);
  return out;
}

function encodeU32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value >>> 0, 0);
  return out;
}

export interface SettleTabVoucherParams {
  vaultPda: PublicKey;
  swigAddress: PublicKey;
  dexterAuthority: PublicKey; // must be a signer at tx-build time
  /** V6: the seller this voucher pays — names the session PDA (seed);
   *  NOT part of the 44-byte signed voucher message (layout unchanged). */
  allowedCounterparty: PublicKey;
  channelId: Uint8Array; // 32 bytes
  cumulativeAmount: bigint; // atomic units (6-decimal USDC)
  sequenceNumber: number; // u32
}

export function buildSettleTabVoucherInstruction(p: SettleTabVoucherParams): TransactionInstruction {
  if (p.channelId.length !== 32) {
    throw new Error(`channelId must be 32 bytes, got ${p.channelId.length}`);
  }
  const argsBuf = Buffer.concat([
    encodeFixedBytes(p.channelId, 32),
    encodeU64(p.cumulativeAmount),
    encodeU32(p.sequenceNumber),
    p.allowedCounterparty.toBuffer(),
  ]);
  const data = Buffer.concat([Buffer.from(DISCRIMINATORS.settle_tab_voucher), argsBuf]);
  const swigWalletAddress = deriveSwigWalletAddress(p.swigAddress);
  const [sessionPda] = deriveSessionPda(p.vaultPda, p.allowedCounterparty);

  return new TransactionInstruction({
    programId: DEXTER_VAULT_PROGRAM_ID,
    keys: [
      { pubkey: p.swigAddress, isSigner: false, isWritable: false },
      { pubkey: swigWalletAddress, isSigner: false, isWritable: false },
      { pubkey: p.vaultPda, isSigner: false, isWritable: true },
      { pubkey: sessionPda, isSigner: false, isWritable: true },
      { pubkey: p.dexterAuthority, isSigner: true, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    ],
    data,
  });
}
