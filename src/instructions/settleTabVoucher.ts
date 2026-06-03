/**
 * settle_tab_voucher — Tab streaming settlement; the vault verifies the
 * session-key signature (via an Ed25519 precompile sibling) and then drives
 * the Swig transfer via its role-3 ProgramExec authority.
 *
 * Verbatim port of dexter-api/src/vault/instructions.ts:458-481.
 *
 * Account ordering MUST match the on-chain Anchor struct:
 *   [0] swig                  — required by Swig's ProgramExec validator
 *   [1] swig_wallet_address   — canonical PDA under the Swig program
 *   [2] vault                 — the vault PDA being mutated
 *   [3] dexter_authority      — signer; must equal vault.dexter_authority
 *   [4] instructions_sysvar   — for the Ed25519 precompile sibling lookup
 */

import {
  PublicKey,
  TransactionInstruction,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from '@solana/web3.js';

import { DEXTER_VAULT_PROGRAM_ID, DISCRIMINATORS } from '../constants/index.js';
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
  ]);
  const data = Buffer.concat([Buffer.from(DISCRIMINATORS.settle_tab_voucher), argsBuf]);
  const swigWalletAddress = deriveSwigWalletAddress(p.swigAddress);

  return new TransactionInstruction({
    programId: DEXTER_VAULT_PROGRAM_ID,
    keys: [
      { pubkey: p.swigAddress, isSigner: false, isWritable: false },
      { pubkey: swigWalletAddress, isSigner: false, isWritable: false },
      { pubkey: p.vaultPda, isSigner: false, isWritable: true },
      { pubkey: p.dexterAuthority, isSigner: true, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    ],
    data,
  });
}
