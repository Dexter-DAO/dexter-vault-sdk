import { describe, test, expect, vi } from 'vitest';
import { Connection, PublicKey } from '@solana/web3.js';
import { readTabMeter } from '../src/tab/readTabMeter.js';
import { deriveSessionPda } from '../src/session/index.js';
import { SESSION_ACCOUNT_DISCRIMINATOR, SESSION_ACCOUNT_SIZE } from '../src/constants/index.js';

const VAULT = new PublicKey('SysvarC1ock11111111111111111111111111111111');
const COUNTERPARTY = new PublicKey('SysvarRent111111111111111111111111111111111');
const FUTURE = 4_000_000_000; // ~2096, past any test clock
const PAST = 1_000_000_000;   // 2001

/** Real 162-byte SessionAccount fixture (same pattern as tests/session.fetch.test.ts). */
function rawSession(opts: {
  version?: number;
  maxAmount?: bigint;
  expiresAt?: number;
  spent?: bigint;
  currentOutstanding?: bigint;
} = {}): Buffer {
  const data = Buffer.alloc(SESSION_ACCOUNT_SIZE);
  Buffer.from(SESSION_ACCOUNT_DISCRIMINATOR).copy(data, 0);
  data.writeUInt8(opts.version ?? 1, 8);             // version
  data.writeUInt8(255, 9);                           // bump
  VAULT.toBuffer().copy(data, 10);                   // vault
  Buffer.alloc(32, 0x07).copy(data, 42);             // session_pubkey
  data.writeBigUInt64LE(opts.maxAmount ?? 5_000_000n, 74);
  data.writeBigInt64LE(BigInt(opts.expiresAt ?? FUTURE), 82);
  COUNTERPARTY.toBuffer().copy(data, 90);            // allowed_counterparty
  data.writeUInt32LE(42, 122);                       // nonce
  data.writeBigUInt64LE(opts.spent ?? 3_000_000n, 126);
  data.writeBigUInt64LE(opts.currentOutstanding ?? 250_000n, 134);
  return data;
}

function connWith(data: Buffer | null): Connection {
  return {
    getAccountInfo: vi.fn().mockResolvedValue(data ? { data } : null),
  } as unknown as Connection;
}

describe('readTabMeter (V6: per-(vault, counterparty) session PDA)', () => {
  test('reads the session PDA and reports spent/cap/remaining/outstanding/expiry', async () => {
    const conn = connWith(rawSession());
    const m = await readTabMeter(conn, VAULT, COUNTERPARTY);
    expect(m.spent).toBe(3_000_000n);
    expect(m.maxAmount).toBe(5_000_000n);
    expect(m.remaining).toBe(2_000_000n); // cap - spent
    expect(m.currentOutstanding).toBe(250_000n);
    expect(m.expiresAt).toBe(FUTURE);

    const [pda] = deriveSessionPda(VAULT, COUNTERPARTY);
    const [calledKey] = (conn.getAccountInfo as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(calledKey.equals(pda)).toBe(true);
  });

  test('remaining clamps at 0 (never negative) when spent exceeds cap', async () => {
    const conn = connWith(rawSession({ spent: 6_000_000n, maxAmount: 5_000_000n }));
    const m = await readTabMeter(conn, VAULT, COUNTERPARTY);
    expect(m.remaining).toBe(0n);
  });

  test('throws when the session PDA is absent', async () => {
    await expect(readTabMeter(connWith(null), VAULT, COUNTERPARTY)).rejects.toThrow(
      new RegExp(`no live session for counterparty ${COUNTERPARTY.toBase58()}`),
    );
  });

  test('throws on a cleared (version 0) session', async () => {
    const conn = connWith(rawSession({ version: 0 }));
    await expect(readTabMeter(conn, VAULT, COUNTERPARTY)).rejects.toThrow(/no live session/);
  });

  test('throws on an expired session (a meter must not report a dead cap)', async () => {
    const conn = connWith(rawSession({ expiresAt: PAST }));
    await expect(readTabMeter(conn, VAULT, COUNTERPARTY)).rejects.toThrow(/no live session/);
  });
});
