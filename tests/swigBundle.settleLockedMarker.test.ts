import { describe, it, expect } from 'vitest';
import { SWIG_PROGRAM_EXEC_MARKERS, SWIG_PROGRAM_EXEC_PREFIX_SETTLE_LOCKED } from '../src/instructions/swigBundle.js';
import { DISCRIMINATORS } from '../src/constants/index.js';

describe('settle_locked ProgramExec marker', () => {
  it('exports a marker equal to the settle_locked_voucher discriminator', () => {
    expect(Array.from(SWIG_PROGRAM_EXEC_PREFIX_SETTLE_LOCKED))
      .toEqual(Array.from(DISCRIMINATORS.settle_locked_voucher));
  });
  it('includes the settle_locked marker in the markers list', () => {
    const hexes = SWIG_PROGRAM_EXEC_MARKERS.map((m) => Buffer.from(m).toString('hex'));
    expect(hexes).toContain(Buffer.from(DISCRIMINATORS.settle_locked_voucher).toString('hex'));
  });
});
