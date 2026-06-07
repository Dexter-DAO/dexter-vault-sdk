import { describe, test, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { readTabMeter } from '../src/tab/readTabMeter.js';

describe('readTabMeter', () => {
  test('reports spent/cap/remaining; never throws (report, not refuse)', async () => {
    const fakeRead = async () => ({ activeSession: { spent: 3_000_000n, maxAmount: 5_000_000n } });
    const m = await readTabMeter({} as any, new PublicKey('SysvarC1ock11111111111111111111111111111111'), fakeRead as any);
    expect(m.spent).toBe(3_000_000n);
    expect(m.maxAmount).toBe(5_000_000n);
    expect(m.remaining).toBe(2_000_000n); // cap - spent
  });

  test('remaining clamps at 0 (never negative) when spent exceeds cap', async () => {
    const fakeRead = async () => ({ activeSession: { spent: 6_000_000n, maxAmount: 5_000_000n } });
    const m = await readTabMeter({} as any, new PublicKey('SysvarC1ock11111111111111111111111111111111'), fakeRead as any);
    expect(m.remaining).toBe(0n);
  });

  test('throws when there is no active session', async () => {
    const fakeRead = async () => ({ activeSession: null });
    await expect(
      readTabMeter({} as any, new PublicKey('SysvarC1ock11111111111111111111111111111111'), fakeRead as any),
    ).rejects.toThrow(/no active session/);
  });
});
