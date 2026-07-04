import { describe, expect, it } from 'vitest';

import { accrualTsFor } from './credit.js';

// D6 quote bounds: the settlement accrual_ts is the margin-adjusted chain
// clock FLOORED at the node's accrual clock. Without the floor, a settlement
// built within the 2s margin of a clock-advancing touch (draw / reprice /
// settle) quotes BEFORE last_accrual and reverts AccrualTsInvalid — the fork
// carry test caught exactly this (repay immediately after a draw).
describe('accrualTsFor', () => {
  it('passes the chain quote through when it is at or past the node clock', () => {
    expect(accrualTsFor(1_000n, { lastAccrual: 900 })).toBe(1_000n);
    expect(accrualTsFor(1_000n, { lastAccrual: 1_000n })).toBe(1_000n);
  });
  it('floors at last_accrual when the margin-adjusted quote falls behind it', () => {
    // draw landed at 1_001; sysvar read 1_002 − 2s margin = 1_000 < 1_001
    expect(accrualTsFor(1_000n, { lastAccrual: 1_001 })).toBe(1_001n);
    expect(accrualTsFor(1_000n, { lastAccrual: 1_002n })).toBe(1_002n);
  });
});
