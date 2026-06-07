/**
 * readTabMeter — READ-ONLY tab reporter. Reports remaining headroom under the
 * session cap; NEVER refuses. The on-chain cap guard is authoritative; a
 * client-side refuser would invite a stale-cache TOCTOU bug.
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { readVaultFull } from '../reader/index.js';
import type { VaultStateFull } from '../types.js';

export interface TabMeter {
  spent: bigint;        // activeSession.spent
  maxAmount: bigint;    // activeSession.maxAmount — the session cap
  remaining: bigint;    // max(0, maxAmount - spent)
}

export async function readTabMeter(
  connection: Connection,
  vaultPda: PublicKey,
  read: (c: Connection, v: PublicKey) => Promise<VaultStateFull> = readVaultFull,
): Promise<TabMeter> {
  const vault = await read(connection, vaultPda);
  const session = vault.activeSession;
  if (!session) throw new Error('readTabMeter: no active session on vault');
  const { spent, maxAmount } = session;
  const raw = maxAmount - spent;
  const remaining = raw > 0n ? raw : 0n;
  return { spent, maxAmount, remaining };
}
