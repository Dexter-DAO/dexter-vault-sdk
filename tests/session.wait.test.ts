/**
 * waitForSession — content-aware confirm-visibility polling.
 *
 * The bug this pins: on rate-limited RPC, a read right after a confirmed
 * register/revoke can return STALE data (read-your-writes lag). Existence
 * and version!=0 are BLIND to a REPLACE — the OLD registration satisfies
 * both. Only CONTENT (the new session_pubkey, or version==0 for revoke)
 * proves the write is visible. Hit and fixed on mainnet 2026-06-09.
 */
import { describe, test, expect, vi } from 'vitest';
import { Connection, PublicKey } from '@solana/web3.js';
import { waitForSession } from '../src/session/index.js';
import { deriveSessionPda } from '../src/session/index.js';
import type { SessionAccountState } from '../src/types.js';

const vault = PublicKey.unique();
const counterparty = PublicKey.unique();
const [sessionPda] = deriveSessionPda(vault, counterparty);
const connection = {} as Connection; // never touched — every test injects fetch

const OLD_PUBKEY = new Uint8Array(32).fill(0x0a);
const NEW_PUBKEY = new Uint8Array(32).fill(0x0b);

/** Plain-object state builder — no bytes needed, waitForSession reads decoded state. */
function sessionState(opts: {
  version?: number;
  sessionPubkey?: Uint8Array;
}): SessionAccountState {
  return {
    address: sessionPda.toBase58(),
    version: opts.version ?? 1,
    bump: 255,
    vault: vault.toBase58(),
    session: {
      sessionPubkey: opts.sessionPubkey ?? OLD_PUBKEY,
      maxAmount: 1_000_000n,
      expiresAt: 4_000_000_000,
      allowedCounterparty: counterparty.toBase58(),
      nonce: 1,
      spent: 0n,
      currentOutstanding: 0n,
      maxRevolvingCapacity: 0n,
      crystallizedCumulative: 0n,
      lastLockedSequence: 0,
    },
  };
}

describe('waitForSession (register mode)', () => {
  test('resolves only once the NEW session_pubkey is visible', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(sessionState({ sessionPubkey: OLD_PUBKEY }))
      .mockResolvedValue(sessionState({ sessionPubkey: NEW_PUBKEY }));
    const s = await waitForSession(connection, vault, counterparty, {
      expectedSessionPubkey: NEW_PUBKEY,
      intervalMs: 1,
      fetch,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(Array.from(s.session.sessionPubkey)).toEqual(Array.from(NEW_PUBKEY));
  });

  test('stale-blind regression pin: version!=0 with the OLD pubkey must NOT resolve', async () => {
    // This is the exact mainnet bug: the stale read LOOKS live (exists,
    // version 1) but still carries the pre-replace registration. An
    // existence/version check would return it as confirmation; content
    // matching must keep polling until timeout instead.
    const fetch = vi.fn().mockResolvedValue(sessionState({ sessionPubkey: OLD_PUBKEY }));
    await expect(
      waitForSession(connection, vault, counterparty, {
        expectedSessionPubkey: NEW_PUBKEY,
        intervalMs: 1,
        timeoutMs: 5,
        fetch,
      }),
    ).rejects.toThrow(/timed out/);
    expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});

describe('waitForSession (cleared mode)', () => {
  test('resolves when version flips to 0', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(sessionState({ version: 1 }))
      .mockResolvedValue(sessionState({ version: 0 }));
    const s = await waitForSession(connection, vault, counterparty, {
      cleared: true,
      intervalMs: 1,
      fetch,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(s.version).toBe(0);
  });
});

describe('waitForSession (usage + timeout)', () => {
  test('neither expectedSessionPubkey nor cleared → usage error before any fetch', async () => {
    const fetch = vi.fn();
    await expect(
      waitForSession(connection, vault, counterparty, { intervalMs: 1, fetch }),
    ).rejects.toThrow(/pass expectedSessionPubkey \(register\) or cleared \(revoke\)/);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('account never appears → rejects with /timed out/ naming the vault', async () => {
    const fetch = vi.fn().mockResolvedValue(null);
    await expect(
      waitForSession(connection, vault, counterparty, {
        expectedSessionPubkey: NEW_PUBKEY,
        intervalMs: 1,
        timeoutMs: 5,
        fetch,
      }),
    ).rejects.toThrow(new RegExp(`timed out.*${vault.toBase58()}`));
  });
});
