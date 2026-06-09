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
  /** Cumulative settled against the cap. */
  spent: bigint;
  /** The session cap. */
  maxAmount: bigint;
  /** max(0, maxAmount - spent) */
  remaining: bigint;
  /** V6: the revolving meter. */
  currentOutstanding: bigint;
  /** Unix seconds. */
  expiresAt: number;
}

export async function readTabMeter(
  connection: Connection,
  vaultPda: PublicKey,
  allowedCounterparty: PublicKey,
): Promise<TabMeter> {
  const s: SessionAccountState | null = await fetchSessionAccount(
    connection,
    vaultPda,
    allowedCounterparty,
  );
  if (!s || !isSessionLive(s)) {
    throw new Error(
      `readTabMeter: no live session for counterparty ${allowedCounterparty.toBase58()} on vault ${vaultPda.toBase58()}`,
    );
  }
  const { spent, maxAmount, currentOutstanding, expiresAt } = s.session;
  const raw = maxAmount - spent;
  return { spent, maxAmount, remaining: raw > 0n ? raw : 0n, currentOutstanding, expiresAt };
}
