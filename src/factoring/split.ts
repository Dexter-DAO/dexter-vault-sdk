/**
 * Factoring split math — pure, no chain dependencies.
 *
 * A LockedClaim of `claimAmount` is settled by its holder (the financier).
 * Factoring routes most of that to the SELLER (instant cash now) and keeps a
 * `financierSpread` for the financier — payment-certainty pricing, NOT interest
 * (short claims earn ~nothing on APR; the spread is a clearing/liquidity fee).
 *
 * INVARIANT: sellerReceives + financierSpread === claimAmount, exactly. The two
 * inner SignV2 transfers source from the swig-wallet ATA and together cannot
 * exceed what the claim reserved, so they must sum to the claim amount.
 *
 * The SDK does NOT decide the spread — the caller (operator policy, e.g.
 * dexter-api) supplies it. This keeps the SDK a neutral mechanism.
 */
export interface FactoringSplitParams {
  /** The full LockedClaim amount, atomic units (USDC = 6 decimals). */
  claimAmount: bigint;
  /** The financier's spread, atomic units. 0 ≤ spread ≤ claimAmount. */
  financierSpread: bigint;
}

export interface FactoringSplit {
  /** What the seller receives now (claimAmount - financierSpread). */
  sellerReceives: bigint;
  /** The financier's spread, echoed back for the transfer builder. */
  financierSpread: bigint;
}

export function computeFactoringSplit(p: FactoringSplitParams): FactoringSplit {
  if (p.claimAmount <= 0n) {
    throw new Error(`factoring: claim amount must be positive, got ${p.claimAmount}`);
  }
  if (p.financierSpread < 0n) {
    throw new Error(`factoring: spread must not be negative, got ${p.financierSpread}`);
  }
  if (p.financierSpread > p.claimAmount) {
    throw new Error(`factoring: spread exceeds claim (${p.financierSpread} > ${p.claimAmount})`);
  }
  return {
    sellerReceives: p.claimAmount - p.financierSpread,
    financierSpread: p.financierSpread,
  };
}
