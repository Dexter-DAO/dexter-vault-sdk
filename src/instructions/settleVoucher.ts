/**
 * settle_voucher — counter ix; dexter_authority increments or decrements
 * the vault's pending_voucher_count.
 *
 * V6 multi-session layout: the session ACCOUNT is Anchor-optional.
 *   - increment=true (tab-open): the real SessionAccount PDA
 *     ([b"session", vault, allowed_counterparty]) is REQUIRED (writable) —
 *     the program raises that session's meter.
 *   - increment=false (close): Anchor's optional-account None convention —
 *     the PROGRAM ID is passed in the slot (readonly, non-signer).
 * allowed_counterparty is a required Borsh arg on BOTH paths.
 *
 * Accounts:
 *   [0] vault            (writable)
 *   [1] dexter_authority (signer)
 *   [2] session          (OPTIONAL — real writable PDA when increment=true,
 *                          program-ID sentinel readonly when increment=false)
 *
 * Args (Borsh after the 8-byte discriminator):
 *   amount: u64
 *   increment: bool
 *   allowed_counterparty: Pubkey (32 bytes, appended LAST)
 */

import { PublicKey, TransactionInstruction } from '@solana/web3.js';

import { DEXTER_VAULT_PROGRAM_ID, DISCRIMINATORS } from '../constants/index.js';
import { deriveSessionPda } from '../session/index.js';

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
  /** V6: the counterparty whose session meter rises at tab-open. Required in
   *  args on both paths (Borsh); the session ACCOUNT is only real on the
   *  increment path — the close path uses Anchor's optional-account None
   *  sentinel (the program ID). */
  allowedCounterparty: PublicKey;
  amount: bigint;
  increment: boolean;
}

export function buildSettleVoucherInstruction(p: SettleVoucherParams): TransactionInstruction {
  const argsBuf = Buffer.concat([
    encodeU64(p.amount),
    encodeBool(p.increment),
    p.allowedCounterparty.toBuffer(),
  ]);
  const data = Buffer.concat([Buffer.from(DISCRIMINATORS.settle_voucher), argsBuf]);

  const sessionMeta = p.increment
    ? { pubkey: deriveSessionPda(p.vaultPda, p.allowedCounterparty)[0], isSigner: false, isWritable: true }
    : { pubkey: DEXTER_VAULT_PROGRAM_ID, isSigner: false, isWritable: false };

  return new TransactionInstruction({
    programId: DEXTER_VAULT_PROGRAM_ID,
    keys: [
      { pubkey: p.vaultPda, isSigner: false, isWritable: true },
      { pubkey: p.dexterAuthority, isSigner: true, isWritable: false },
      sessionMeta,
    ],
    data,
  });
}
