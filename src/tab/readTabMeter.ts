/**
 * readTabMeter — READ-ONLY tab reporter. Reports remaining headroom under the
 * session cap; NEVER refuses. The on-chain cap guard is authoritative; a
 * client-side refuser would invite a stale-cache TOCTOU bug.
 * V6: the session lives in a per-counterparty SessionAccount PDA, so the
 * meter is per-(vault, counterparty).
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { fetchSessionAccount, isSessionLive } from '../session/index.js';
import type { SessionAccountState } from '../types.js';

export interface TabMeter {
  spent: bigint;
  maxAmount: bigint;
  remaining: bigint;          // max(0, maxAmount - spent)
  currentOutstanding: bigint; // V6: the revolving meter
  expiresAt: number;
}

export async function readTabMeter(
  connection: Connection,
  vaultPda: PublicKey,
  allowedCounterparty: PublicKey,
  fetch: typeof fetchSessionAccount = fetchSessionAccount,
): Promise<TabMeter> {
  const s: SessionAccountState | null = await fetch(connection, vaultPda, allowedCounterparty);
  if (!s || !isSessionLive(s)) {
    throw new Error(
      `readTabMeter: no live session for counterparty ${allowedCounterparty.toBase58()}`,
    );
  }
  const { spent, maxAmount, currentOutstanding, expiresAt } = s.session;
  const raw = maxAmount - spent;
  return { spent, maxAmount, remaining: raw > 0n ? raw : 0n, currentOutstanding, expiresAt };
}
