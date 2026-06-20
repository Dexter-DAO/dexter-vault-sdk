/**
 * openTab — composes the settle_voucher(increment) leg that raises the tab's
 * outstanding and arms it. Returns instructions; does NOT send.
 *
 * V6: settle_voucher takes { vaultPda, dexterAuthority, allowedCounterparty,
 * amount, increment }. The increment path requires the real per-counterparty
 * SessionAccount PDA ([b"session", vault, allowed_counterparty]) — the
 * builder derives and carries it so the program can raise that session's
 * meter. Still no swigAddress param (no lying/unused params).
 */
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { buildSettleVoucherInstruction } from '../instructions/index.js';

export interface OpenTabParams {
  vaultPda: PublicKey;
  amount: bigint;            // outstanding to arm
  dexterAuthority: PublicKey;
  /** V6: the seller this tab is opened against — names the session PDA. */
  allowedCounterparty: PublicKey;
}

export async function buildOpenTabInstructions(p: OpenTabParams): Promise<TransactionInstruction[]> {
  const ix = buildSettleVoucherInstruction({
    vaultPda: p.vaultPda,
    amount: p.amount,
    increment: true,
    dexterAuthority: p.dexterAuthority,
    allowedCounterparty: p.allowedCounterparty,
  });
  return [ix];
}
