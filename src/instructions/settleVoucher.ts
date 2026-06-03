/**
 * settle_voucher — legacy counter-only ix; dexter_authority increments or
 * decrements the vault's pending_voucher_count.
 *
 * Verbatim port of dexter-api/src/vault/instructions.ts:202-214.
 */

import { PublicKey, TransactionInstruction } from '@solana/web3.js';

import { DEXTER_VAULT_PROGRAM_ID, DISCRIMINATORS } from '../constants/index.js';

function encodeU64(value: bigint): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(value, 0);
  return out;
}

function encodeBool(value: boolean): Buffer {
  return Buffer.from([value ? 1 : 0]);
}

export interface SettleVoucherParams {
  vaultPda: PublicKey;
  dexterAuthority: PublicKey; // must equal the vault's bound dexter_authority (has_one)
  amount: bigint;
  increment: boolean;
}

export function buildSettleVoucherInstruction(p: SettleVoucherParams): TransactionInstruction {
  const argsBuf = Buffer.concat([encodeU64(p.amount), encodeBool(p.increment)]);
  const data = Buffer.concat([Buffer.from(DISCRIMINATORS.settle_voucher), argsBuf]);

  return new TransactionInstruction({
    programId: DEXTER_VAULT_PROGRAM_ID,
    keys: [
      { pubkey: p.vaultPda, isSigner: false, isWritable: true },
      { pubkey: p.dexterAuthority, isSigner: true, isWritable: false },
    ],
    data,
  });
}
