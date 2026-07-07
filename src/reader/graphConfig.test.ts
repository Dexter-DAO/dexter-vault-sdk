import { describe, it, expect } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  parseGraphConfigData,
  effectiveMaxSellerAtRiskAtomic,
  MAX_SELLER_AT_RISK_CAP,
  MAX_SELLER_AT_RISK_DEFAULT,
} from './graphConfig.js';

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
    buf.writeBigUInt64LE(5_000n, 159); // max_seller_at_risk_atomic

    const cfg = parseGraphConfigData(buf);
    expect(cfg.version).toBe(2);
    expect(cfg.adminAuthority.equals(admin)).toBe(true);
    expect(cfg.pauseAuthority.equals(pauseAuth)).toBe(true);
    expect(cfg.paused).toBe(true);
    expect(cfg.usdcMint.equals(usdc)).toBe(true);
    expect(cfg.withdrawalFeeAtomic).toBe(500_000n);
    expect(cfg.feeTreasury.equals(treasury)).toBe(true);
    expect(cfg.maxSellerAtRiskAtomic).toBe(5_000n);
    expect(effectiveMaxSellerAtRiskAtomic(cfg)).toBe(5_000n); // set → passthrough
  });

  it('rejects a V1-length (unmigrated) account', () => {
    expect(() => parseGraphConfigData(Buffer.alloc(117))).toThrow(
      /graph_config not migrated/,
    );
  });

  // ── max_seller_at_risk_atomic (penny lock, K-T1 #77) ─────────────────────

  it('reads knob 0 (live mainnet state) as raw 0 and effective = the default penny', () => {
    // Live mainnet config: the field spells the account's pre-#77 zeroed
    // reserved bytes → raw 0 = "unset". The 0→default substitution is the
    // reader's job — the SDK returns the penny, no admin action needed.
    const buf = Buffer.alloc(221);
    buf[8] = 2;
    const cfg = parseGraphConfigData(buf);
    expect(cfg.maxSellerAtRiskAtomic).toBe(0n);
    expect(effectiveMaxSellerAtRiskAtomic(cfg)).toBe(MAX_SELLER_AT_RISK_DEFAULT);
    expect(effectiveMaxSellerAtRiskAtomic(cfg)).toBe(10_000n);
  });

  it('pins max_seller_at_risk_atomic to bytes 159..167 — a field shuffle screams here', () => {
    // Poison EVERY byte, then carve only the pinned windows. If the decoder
    // read even one byte outside 159..167 for the knob (or 157..159 for
    // interest_take_bps), 0xFF bleed corrupts the value and this fails.
    const buf = Buffer.alloc(221, 0xff);
    buf.writeUInt16LE(4_242, 157); // interest_take_bps neighbor (left fence)
    buf.writeBigUInt64LE(777_777n, 159); // the knob
    // bytes 167..221 (reserved) stay 0xFF — right-fence poison.
    const cfg = parseGraphConfigData(buf);
    expect(cfg.interestTakeBps).toBe(4_242);
    expect(cfg.maxSellerAtRiskAtomic).toBe(777_777n);
  });

  it('pins the exported program constants', () => {
    // programs/dexter-vault/src/constants.rs (kt1-program-guard-knob ec95012):
    // CAP = 1_000_000 ($1.00 ceiling on the cold-key knob),
    // DEFAULT = 10_000 ($0.01 — the 2026-07-06 penny ruling).
    expect(MAX_SELLER_AT_RISK_CAP).toBe(1_000_000n);
    expect(MAX_SELLER_AT_RISK_DEFAULT).toBe(10_000n);
  });

  it('effectiveMaxSellerAtRiskAtomic substitutes ONLY on exact 0', () => {
    expect(effectiveMaxSellerAtRiskAtomic({ maxSellerAtRiskAtomic: 0n })).toBe(10_000n);
    expect(effectiveMaxSellerAtRiskAtomic({ maxSellerAtRiskAtomic: 5_000n })).toBe(5_000n);
    expect(effectiveMaxSellerAtRiskAtomic({ maxSellerAtRiskAtomic: 1n })).toBe(1n);
    expect(
      effectiveMaxSellerAtRiskAtomic({ maxSellerAtRiskAtomic: MAX_SELLER_AT_RISK_CAP }),
    ).toBe(1_000_000n);
  });
});
