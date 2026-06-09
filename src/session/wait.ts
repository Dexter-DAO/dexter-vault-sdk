/**
 * waitForSession — content-aware confirm-visibility for session writes.
 *
 * WHY: on rate-limited RPC, a read right after a confirmed register/revoke
 * can return STALE data (read-your-writes lag). Existence and version!=0 are
 * BLIND to a REPLACE — the old registration also satisfied both. The reliable
 * signal is CONTENT: the new session_pubkey (register) or version==0 (revoke).
 * This race was hit and fixed on mainnet 2026-06-09 in the program's test
 * harness; this ships the cure to consumers.
 *
 * The injectable `fetch` opt is the deliberate testing/production seam:
 * production callers may have a cached/proxied reader, and the polling loop
 * cannot be tested without it.
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { fetchSessionAccount } from './fetch.js';
import type { SessionAccountState } from '../types.js';

export interface WaitForSessionOpts {
  /** Register/replace mode: resolve when this exact pubkey is visible. */
  expectedSessionPubkey?: Uint8Array;
  /**
   * Revoke mode: resolve when version == 0. The account must exist (revoke
   * clears version in place); waiting on a never-created account times out.
   */
  cleared?: boolean;
  pollIntervalMs?: number;   // default 1000
  timeoutMs?: number;        // default 30_000
  fetch?: typeof fetchSessionAccount;
}

export async function waitForSession(
  connection: Connection,
  vault: PublicKey,
  allowedCounterparty: PublicKey,
  opts: WaitForSessionOpts,
): Promise<SessionAccountState> {
  const { expectedSessionPubkey, cleared, pollIntervalMs = 1000, timeoutMs = 30_000 } = opts;
  if ((!expectedSessionPubkey && !cleared) || (expectedSessionPubkey && cleared)) {
    throw new Error(
      'waitForSession: pass exactly one of expectedSessionPubkey (register) or cleared (revoke)',
    );
  }
  if (expectedSessionPubkey && expectedSessionPubkey.length !== 32) {
    throw new Error(
      `waitForSession: expectedSessionPubkey must be 32 bytes, got ${expectedSessionPubkey.length}`,
    );
  }
  const fetch = opts.fetch ?? fetchSessionAccount;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = await fetch(connection, vault, allowedCounterparty);
    if (s) {
      if (cleared && s.version === 0) return s;
      if (
        expectedSessionPubkey &&
        s.version !== 0 &&
        s.session.sessionPubkey.length === expectedSessionPubkey.length &&
        s.session.sessionPubkey.every((b, i) => b === expectedSessionPubkey[i])
      ) {
        return s;
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `waitForSession: timed out after ${timeoutMs}ms waiting for ` +
        (cleared ? 'cleared session' : 'new session_pubkey visibility') +
        ` on vault ${vault.toBase58()} counterparty ${allowedCounterparty.toBase58()}`,
      );
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
}
