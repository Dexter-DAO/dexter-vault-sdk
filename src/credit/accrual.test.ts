/** Parity tests — these constants mirror accrual.rs's unit tests, so a drift
 *  between the TS and Rust integer math fails HERE before it reverts on-chain. */
import { describe, it, expect } from 'vitest';

import {
  interestDue,
  totalInterestAt,
  treasuryCut,
  quoteRepay,
  quotePayoff,
  quoteSeize,
  SECONDS_PER_YEAR,
} from './accrual.js';

const node = (borrowed: bigint, rateBps: number, lastAccrual: bigint, accruedFee = 0n, shortfall = 0n) => ({
  borrowed, rateBps, accruedFee, lastAccrual, shortfall,
});

describe('accrual math parity with accrual.rs', () => {
  it('one year at 100% APR doubles (rust: one_year_at_100pct_apr_doubles)', () => {
    expect(interestDue(1_000_000_000n, 10_000, 0n, SECONDS_PER_YEAR)).toBe(1_000_000_000n);
  });
  it('60s at 50% on $1000 = 951 atomic (rust: known_value_60s_at_50pct)', () => {
    expect(interestDue(1_000_000_000n, 5_000, 100n, 160n)).toBe(951n);
  });
  it('zero paths', () => {
    expect(interestDue(0n, 5_000, 0n, 1000n)).toBe(0n);
    expect(interestDue(1_000_000n, 0, 0n, 1000n)).toBe(0n);
    expect(interestDue(1_000_000n, 5_000, 1000n, 1000n)).toBe(0n);
    expect(interestDue(1_000_000n, 5_000, 2000n, 1000n)).toBe(0n);
  });
  it('defaulted node clock is stopped (rust: defaulted_node_clock_is_stopped)', () => {
    const n = node(500n, 5_000, 100n, 7n, 500n);
    expect(totalInterestAt(n, SECONDS_PER_YEAR)).toBe(7n);
  });
  it('treasury cut floors toward the financier (rust: cut_floors_toward_financier)', () => {
    expect(treasuryCut(1_000n, 2_500)).toBe(250n);
    expect(treasuryCut(999n, 2_500)).toBe(249n);
    expect(treasuryCut(3n, 2_500)).toBe(0n);
  });
  it('quoteRepay: interest-first split + legs sum to the clamped total', () => {
    const n = node(1_000_000_000n, 5_000, 100n, 40n);
    // partial: 500 pays interest (40 + 951 accrued to ts=160) first
    const q = quoteRepay(n, 1_500n, 160n, 2_500);
    expect(q.interestPaidAtomic).toBe(991n);
    expect(q.principalPaidAtomic).toBe(509n);
    expect(q.treasuryLegAtomic).toBe(247n); // floor(991*0.25)
    expect(q.financierLegAtomic + q.treasuryLegAtomic).toBe(q.totalAtomic);
    // payoff zeroes everything
    const payoff = quotePayoff(n, 160n);
    const q2 = quoteRepay(n, payoff, 160n, 2_500);
    expect(q2.principalPaidAtomic).toBe(1_000_000_000n);
    expect(q2.interestPaidAtomic).toBe(991n);
  });
  it('quoteSeize: principal-first, remainder written off', () => {
    const n = node(500_000_000n, 10_000, 0n);
    // 20s elapsed → 317 atomic interest; collateral covers principal + 100
    const q = quoteSeize(n, 500_000_100n, 20n, 2_500);
    expect(q.principalPaidAtomic).toBe(500_000_000n);
    expect(q.interestPaidAtomic).toBe(100n);
    expect(q.interestWrittenOffAtomic).toBe(217n);
    expect(q.shortfallAtomic).toBe(0n);
    expect(q.treasuryLegAtomic).toBe(25n);
    expect(q.financierLegAtomic).toBe(500_000_075n);
  });
});
