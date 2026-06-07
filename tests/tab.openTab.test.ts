import { describe, test, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { openTab } from '../src/tab/openTab.js';

describe('openTab', () => {
  test('composes the settle_voucher(increment) leg and returns instructions', async () => {
    const ixs = await openTab({
      vaultPda: new PublicKey('SysvarC1ock11111111111111111111111111111111'),
      amount: 1_000_000n,
      dexterAuthority: new PublicKey('11111111111111111111111111111111'),
    });
    expect(Array.isArray(ixs)).toBe(true);
    expect(ixs.length).toBeGreaterThanOrEqual(1);
    expect(ixs[0].programId.equals(new PublicKey('Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc'))).toBe(true);
  });
});
