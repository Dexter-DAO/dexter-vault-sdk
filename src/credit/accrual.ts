/**
 * THE SPREAD ENGINE — client-side accrual math, byte-identical to the on-chain
 * formula (programs/dexter-vault/src/accrual.rs):
 *
 *   interest = borrowed × rate_bps × elapsed_secs / (10_000 × 31_536_000)
 *
 * BigInt floor division throughout — any deviation from the program's integer
 * math builds money legs the program rejects (DebtTransferMismatch).
 *
 * THE DETERMINISM CONTRACT (design D6): settlement instructions
 * (repay_credit / seize_collateral / settle_liquidation) carry an `accrual_ts`
 * — the unix second the client computed interest against. The program bounds
 * it (node.last_accrual <= ts <= now, staleness <= 300s) and accrues to
 * EXACTLY that second, so both sides agree to the atomic unit. ALWAYS source
 * `accrualTs` from the CHAIN clock (getBlockTime of the current slot), never
 * `Date.now()` — local clock skew past the validator's clock reverts with
 * AccrualTsInvalid.
 */

export const SECONDS_PER_YEAR = 31_536_000n;
export const BPS_DENOMINATOR = 10_000n;
/** On-chain cap on PrincipalNode.rate_bps (100% APR). */
export const RATE_BPS_CAP = 10_000;
/** On-chain cap on GraphConfig.interest_take_bps (half of collected interest). */
export const INTEREST_TAKE_CAP_BPS = 5_000;
/** Max age of an accrual_ts at landing time before AccrualTsStale. */
export const ACCRUAL_TS_MAX_STALENESS_SECS = 300;

/** The accrual-relevant slice of a PrincipalNode (accountReader field names). */
export interface AccruingNode {
  borrowed: bigint;
  rateBps: number;
  accruedFee: bigint;
  lastAccrual: bigint;
  /** A defaulted node's clock is stopped (design D4). */
  shortfall: bigint;
}

/** Floor-divided interest on `borrowed` at `rateBps` APR over [fromTs, toTs]. */
export function interestDue(
  borrowed: bigint,
  rateBps: number,
  fromTs: bigint,
  toTs: bigint,
): bigint {
  if (borrowed === 0n || rateBps === 0 || toTs <= fromTs) return 0n;
  return (
    (borrowed * BigInt(rateBps) * (toTs - fromTs)) /
    (BPS_DENOMINATOR * SECONDS_PER_YEAR)
  );
}

/** The node's TOTAL interest claim as of `ts` — banked accrued_fee plus the
 *  un-banked tail. Mirrors accrual.rs::pro_forma_accrued (incl. the stopped
 *  clock on a defaulted node). */
export function totalInterestAt(node: AccruingNode, ts: bigint): bigint {
  if (node.shortfall > 0n) return node.accruedFee;
  return node.accruedFee + interestDue(node.borrowed, node.rateBps, node.lastAccrual, ts);
}

/** The protocol treasury's share of a collected interest slice (floor — dust
 *  favors the financier). Mirrors accrual.rs::treasury_cut. */
export function treasuryCut(interestPaid: bigint, takeBps: number): bigint {
  return (interestPaid * BigInt(takeBps)) / BPS_DENOMINATOR;
}

/** The exact money legs a settlement must build. `treasuryLegAtomic === 0n` ⇒
 *  the envelope is SINGLE-leg (financier only); a positive cut REQUIRES the
 *  two-leg envelope (financier + fee_treasury ATA), amounts exactly these. */
export interface SettlementLegs {
  /** The clamped total the settlement books (principal + interest paid). */
  totalAtomic: bigint;
  principalPaidAtomic: bigint;
  interestPaidAtomic: bigint;
  /** Leg 1 → the node financier's usdc ATA. */
  financierLegAtomic: bigint;
  /** Leg 2 → GraphConfig.fee_treasury's usdc ATA (omit the leg when 0). */
  treasuryLegAtomic: bigint;
}

/**
 * Quote a repay_credit: clamp `amount` to total owed at `accrualTs`, split
 * interest-FIRST (design D3), then financier/treasury (design D5). Mirrors the
 * handler exactly — build the SignV2 legs from THESE numbers and pass the same
 * `accrualTs` in RepayCreditParams.
 */
export function quoteRepay(
  node: AccruingNode,
  amount: bigint,
  accrualTs: bigint,
  interestTakeBps: number,
): SettlementLegs {
  const interestOwed = totalInterestAt(node, accrualTs);
  const owed = node.borrowed + interestOwed;
  const total = amount < owed ? amount : owed;
  const interestPaid = total < interestOwed ? total : interestOwed;
  const principalPaid = total - interestPaid;
  const cut = treasuryCut(interestPaid, interestTakeBps);
  return {
    totalAtomic: total,
    principalPaidAtomic: principalPaid,
    interestPaidAtomic: interestPaid,
    financierLegAtomic: total - cut,
    treasuryLegAtomic: cut,
  };
}

/** The full-payoff amount at `accrualTs` (principal + all interest). Pass this
 *  as the repay `amount` to zero the line in one settlement. */
export function quotePayoff(node: AccruingNode, accrualTs: bigint): bigint {
  return node.borrowed + totalInterestAt(node, accrualTs);
}

/**
 * Quote a seize_collateral / settle_liquidation: principal-FIRST recovery
 * (design D3), interest second up to the available balance, the uncollected
 * remainder written off on-chain (design D4). `available` is the LIVE
 * collateral/proceeds ATA balance the program will read.
 */
export function quoteSeize(
  node: AccruingNode,
  available: bigint,
  accrualTs: bigint,
  interestTakeBps: number,
): SettlementLegs & { shortfallAtomic: bigint; interestWrittenOffAtomic: bigint } {
  const interestOwed = totalInterestAt(node, accrualTs);
  const principalSeized = node.borrowed < available ? node.borrowed : available;
  const room = available - principalSeized;
  const interestSeized = interestOwed < room ? interestOwed : room;
  const total = principalSeized + interestSeized;
  const cut = treasuryCut(interestSeized, interestTakeBps);
  return {
    totalAtomic: total,
    principalPaidAtomic: principalSeized,
    interestPaidAtomic: interestSeized,
    financierLegAtomic: total - cut,
    treasuryLegAtomic: cut,
    shortfallAtomic: node.borrowed - principalSeized,
    interestWrittenOffAtomic: interestOwed - interestSeized,
  };
}
