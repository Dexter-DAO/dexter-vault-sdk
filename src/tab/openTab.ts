/**
 * openTab — composes the settle_voucher(increment) leg that raises the tab's
 * outstanding and arms it. Returns instructions; does NOT send.
 *
 * Note: buildSettleVoucherInstruction needs only { vaultPda, dexterAuthority,
 * amount, increment } — there is no swigAddress param, so we don't accept one
 * (no lying/unused params).
 */
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { buildSettleVoucherInstruction } from '../instructions/index.js';

export interface OpenTabParams {
  vaultPda: PublicKey;
  amount: bigint;            // outstanding to arm
  dexterAuthority: PublicKey;
}

export async function openTab(p: OpenTabParams): Promise<TransactionInstruction[]> {
  const ix = buildSettleVoucherInstruction({
    vaultPda: p.vaultPda,
    amount: p.amount,
    increment: true,
    dexterAuthority: p.dexterAuthority,
  });
  return [ix];
}
