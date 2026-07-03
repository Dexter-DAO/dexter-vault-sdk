import { describe, it, expect } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { parseGraphConfigData } from './graphConfig.js';

function uniqueKey(): PublicKey {
  return Keypair.generate().publicKey;
}

describe('parseGraphConfigData', () => {
  it('parses V2 GraphConfig at the pinned offsets', () => {
    const buf = Buffer.alloc(221);
    buf[8] = 2; // version
    const admin = uniqueKey();
    admin.toBuffer().copy(buf, 10);
    const pauseAuth = uniqueKey();
    pauseAuth.toBuffer().copy(buf, 42);
    buf[74] = 1; // paused
    const usdc = uniqueKey();
    usdc.toBuffer().copy(buf, 85);
    buf.writeBigUInt64LE(500_000n, 117); // withdrawal_fee_atomic
    const treasury = uniqueKey();
    treasury.toBuffer().copy(buf, 125);

    const cfg = parseGraphConfigData(buf);
    expect(cfg.version).toBe(2);
    expect(cfg.adminAuthority.equals(admin)).toBe(true);
    expect(cfg.pauseAuthority.equals(pauseAuth)).toBe(true);
    expect(cfg.paused).toBe(true);
    expect(cfg.usdcMint.equals(usdc)).toBe(true);
    expect(cfg.withdrawalFeeAtomic).toBe(500_000n);
    expect(cfg.feeTreasury.equals(treasury)).toBe(true);
  });

  it('rejects a V1-length (unmigrated) account', () => {
    expect(() => parseGraphConfigData(Buffer.alloc(117))).toThrow(
      /graph_config not migrated/,
    );
  });
});
