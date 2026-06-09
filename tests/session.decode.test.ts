import { describe, test, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { decodeSessionAccount, isSessionLive } from '../src/session/index.js';
import { SESSION_ACCOUNT_DISCRIMINATOR, SESSION_ACCOUNT_SIZE } from '../src/constants/index.js';
import type { SessionAccountState } from '../src/types.js';

const ADDRESS = PublicKey.unique();
const VAULT = PublicKey.unique();
const COUNTERPARTY = PublicKey.unique();

interface FixtureOverrides {
  version?: number;
  expiresAt?: bigint;
}

/** Builds a synthetic 162-byte SessionAccount per the verified V6 layout. */
function buildFixture(overrides: FixtureOverrides = {}): Buffer {
  const buf = Buffer.alloc(SESSION_ACCOUNT_SIZE);
  Buffer.from(SESSION_ACCOUNT_DISCRIMINATOR).copy(buf, 0);            // 0..8  discriminator
  buf.writeUInt8(overrides.version ?? 1, 8);                          // 8     version
  buf.writeUInt8(254, 9);                                             // 9     bump
  VAULT.toBuffer().copy(buf, 10);                                     // 10..42 vault
  Buffer.alloc(32, 0x07).copy(buf, 42);                               // 42..74 session_pubkey
  buf.writeBigUInt64LE(5_000_000n, 74);                               // 74..82 max_amount
  buf.writeBigInt64LE(overrides.expiresAt ?? 4_000_000_000n, 82);     // 82..90 expires_at
  COUNTERPARTY.toBuffer().copy(buf, 90);                              // 90..122 allowed_counterparty
  buf.writeUInt32LE(42, 122);                                         // 122..126 nonce
  buf.writeBigUInt64LE(1_250_000n, 126);                              // 126..134 spent
  buf.writeBigUInt64LE(300_000n, 134);                                // 134..142 current_outstanding
  buf.writeBigUInt64LE(2_000_000n, 142);                              // 142..150 max_revolving_capacity
  buf.writeBigUInt64LE(750_000n, 150);                                // 150..158 crystallized_cumulative
  buf.writeUInt32LE(9, 158);                                          // 158..162 last_locked_sequence
  return buf;
}

describe('decodeSessionAccount', () => {
  test('decodes every field at the verified offsets', () => {
    const state = decodeSessionAccount(ADDRESS, buildFixture());

    expect(state.address).toBe(ADDRESS.toBase58());
    expect(state.version).toBe(1);
    expect(state.bump).toBe(254);
    expect(state.vault).toBe(VAULT.toBase58());

    expect(state.session.sessionPubkey).toEqual(new Uint8Array(32).fill(0x07));
    expect(state.session.maxAmount).toBe(5_000_000n);
    expect(state.session.expiresAt).toBe(4_000_000_000);
    expect(state.session.allowedCounterparty).toBe(COUNTERPARTY.toBase58());
    expect(state.session.nonce).toBe(42);
    expect(state.session.spent).toBe(1_250_000n);
    expect(state.session.currentOutstanding).toBe(300_000n);
    expect(state.session.maxRevolvingCapacity).toBe(2_000_000n);
    expect(state.session.crystallizedCumulative).toBe(750_000n);
    expect(state.session.lastLockedSequence).toBe(9);
  });

  test('rejects wrong size (161 bytes)', () => {
    const short = buildFixture().subarray(0, 161);
    expect(() => decodeSessionAccount(ADDRESS, short)).toThrow(/size/);
  });

  test('rejects corrupted discriminator', () => {
    const bad = buildFixture();
    bad[0] ^= 0xff;
    expect(() => decodeSessionAccount(ADDRESS, bad)).toThrow(/discriminator/);
  });
});

describe('isSessionLive', () => {
  function decode(overrides: FixtureOverrides = {}): SessionAccountState {
    return decodeSessionAccount(ADDRESS, buildFixture(overrides));
  }

  test('true for version 1 + future expiry', () => {
    expect(isSessionLive(decode(), 3_999_999_999)).toBe(true);
  });

  test('false for version 0 even with future expiry', () => {
    expect(isSessionLive(decode({ version: 0 }), 3_999_999_999)).toBe(false);
  });

  test('false for expired session', () => {
    expect(isSessionLive(decode({ expiresAt: 1000n }), 3_999_999_999)).toBe(false);
  });
});
