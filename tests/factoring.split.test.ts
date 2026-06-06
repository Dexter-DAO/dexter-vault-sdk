import { describe, it, expect } from 'vitest';
import { computeFactoringSplit } from '../src/factoring/split.js';

describe('computeFactoringSplit', () => {
  it('splits a claim into sellerReceives + financierSpread (the $63 / $0.63 example)', () => {
    const out = computeFactoringSplit({ claimAmount: 63_000_000n, financierSpread: 630_000n });
    expect(out.sellerReceives).toBe(62_370_000n);
    expect(out.financierSpread).toBe(630_000n);
    expect(out.sellerReceives + out.financierSpread).toBe(63_000_000n);
  });

  it('allows a zero spread (seller gets everything)', () => {
    const out = computeFactoringSplit({ claimAmount: 1_000_000n, financierSpread: 0n });
    expect(out.sellerReceives).toBe(1_000_000n);
    expect(out.financierSpread).toBe(0n);
  });

  it('rejects a spread larger than the claim', () => {
    expect(() => computeFactoringSplit({ claimAmount: 1_000_000n, financierSpread: 1_000_001n }))
      .toThrow(/spread exceeds claim/i);
  });

  it('rejects a negative spread', () => {
    expect(() => computeFactoringSplit({ claimAmount: 1_000_000n, financierSpread: -1n }))
      .toThrow(/negative/i);
  });

  it('rejects a zero or negative claim amount', () => {
    expect(() => computeFactoringSplit({ claimAmount: 0n, financierSpread: 0n }))
      .toThrow(/claim amount/i);
  });
});
