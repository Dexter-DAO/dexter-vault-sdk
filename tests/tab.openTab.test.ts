import { describe, test, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { buildOpenTabInstructions } from '../src/tab/openTab.js';
import { deriveSessionPda } from '../src/session/index.js';

const VAULT = new PublicKey('SysvarC1ock11111111111111111111111111111111');
const COUNTERPARTY = new PublicKey('SysvarS1otHashes111111111111111111111111111');

describe('openTab', () => {
  test('composes the settle_voucher(increment) leg carrying the session PDA', async () => {
    const ixs = await buildOpenTabInstructions({
      vaultPda: VAULT,
      amount: 1_000_000n,
      dexterAuthority: new PublicKey('11111111111111111111111111111111'),
      allowedCounterparty: COUNTERPARTY,
    });
    expect(Array.isArray(ixs)).toBe(true);
    expect(ixs.length).toBeGreaterThanOrEqual(1);
    expect(ixs[0].programId.equals(new PublicKey('Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc'))).toBe(true);

    // V6: increment path requires the real session PDA at index 2, writable.
    const [sessionPda] = deriveSessionPda(VAULT, COUNTERPARTY);
    expect(ixs[0].keys[2].pubkey.equals(sessionPda)).toBe(true);
    expect(ixs[0].keys[2].isWritable).toBe(true);

    // Data: disc(8) + amount u64 + increment bool + counterparty(32, LAST).
    const data = ixs[0].data;
    expect(data.readBigUInt64LE(8)).toBe(1_000_000n); // amount packed correctly
    expect(data.readUInt8(16)).toBe(1);               // increment flag === true
    expect(Buffer.from(data.subarray(data.length - 32)).equals(COUNTERPARTY.toBuffer())).toBe(true);
  });
});
