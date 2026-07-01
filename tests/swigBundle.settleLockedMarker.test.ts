import { describe, it, expect } from 'vitest';
import {
  SWIG_PROGRAM_EXEC_MARKERS,
  SWIG_PROGRAM_EXEC_PREFIX_SETTLE_LOCKED,
  SWIG_PROGRAM_EXEC_PREFIX_REPAY,
  SWIG_PROGRAM_EXEC_PREFIX_SEIZE,
} from '../src/instructions/swigBundle.js';
import { DISCRIMINATORS } from '../src/constants/index.js';

describe('canonical ProgramExec markers (7-authority reconciliation)', () => {
  it('settle_locked marker == settle_locked_voucher discriminator', () => {
    expect(Array.from(SWIG_PROGRAM_EXEC_PREFIX_SETTLE_LOCKED)).toEqual(
      Array.from(DISCRIMINATORS.settle_locked_voucher),
    );
  });
  it('repay marker == repay_credit discriminator', () => {
    expect(Array.from(SWIG_PROGRAM_EXEC_PREFIX_REPAY)).toEqual(
      Array.from(DISCRIMINATORS.repay_credit),
    );
  });
  it('seize marker == seize_collateral discriminator', () => {
    expect(Array.from(SWIG_PROGRAM_EXEC_PREFIX_SEIZE)).toEqual(
      Array.from(DISCRIMINATORS.seize_collateral),
    );
  });

  it('markers list contains settle_locked + repay + seize', () => {
    const hexes = SWIG_PROGRAM_EXEC_MARKERS.map((m) => Buffer.from(m).toString('hex'));
    for (const disc of [
      DISCRIMINATORS.settle_locked_voucher,
      DISCRIMINATORS.repay_credit,
      DISCRIMINATORS.seize_collateral,
    ]) {
      expect(hexes).toContain(Buffer.from(disc).toString('hex'));
    }
  });

  it('markers list has no duplicates (each role a distinct marker)', () => {
    const hexes = SWIG_PROGRAM_EXEC_MARKERS.map((m) => Buffer.from(m).toString('hex'));
    expect(new Set(hexes).size).toBe(hexes.length);
  });
});
