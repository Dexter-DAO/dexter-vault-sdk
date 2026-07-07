/**
 * GraphConfig (V2) reader — the on-chain source of truth for the withdrawal
 * fee model. finalize-withdrawal clients MUST price the fee from here, never
 * from a local constant: the program enforces leg amounts against THESE bytes,
 * so a locally-cached fee that drifts from chain state builds transactions the
 * program rejects (the 2026-07-03 bricking class).
 *
 * V2 byte map (after the 8-byte account discriminator):
 *   version@8, bump@9, admin_authority@10..42, pause_authority@42..74,
 *   paused@74, paused_at@75..83, pause_reason@83, max_depth_override@84,
 *   usdc_mint@85..117, withdrawal_fee_atomic@117..125, fee_treasury@125..157,
 *   interest_take_bps@157..159 (spread engine, carved from the reserved tail),
 *   max_seller_at_risk_atomic@159..167 (penny lock, carved from the reserved
 *   head — K-T1 #77), reserved@167..221.
 * Mirrors programs/dexter-vault/src/instructions/migrate_graph_config_v2.rs,
 * whose layout-pin unit test ties 221 to `8 + GraphConfig::INIT_SPACE`.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { deriveGraphConfigPda } from '../credit/derive.js';

/** On-chain ceiling for `max_seller_at_risk_atomic` (programs/dexter-vault/src/
 *  constants.rs::MAX_SELLER_AT_RISK_CAP). `set_max_seller_at_risk` rejects
 *  anything above this: a compromised cold key can loosen seller protection to
 *  at most $1.00, never disable it. */
export const MAX_SELLER_AT_RISK_CAP = 1_000_000n;

/** The 0-means-unset substitution value for `max_seller_at_risk_atomic`
 *  (programs/dexter-vault/src/constants.rs::MAX_SELLER_AT_RISK_DEFAULT):
 *  10_000 atomic = $0.01, the 2026-07-06 penny ruling. Live configs whose
 *  zeroed reserved bytes now spell this field are at the penny with no admin
 *  action — see effectiveMaxSellerAtRiskAtomic. */
export const MAX_SELLER_AT_RISK_DEFAULT = 10_000n;

export interface GraphConfigOnchain {
  version: number;
  adminAuthority: PublicKey;
  pauseAuthority: PublicKey;
  paused: boolean;
  usdcMint: PublicKey;
  /** Flat withdrawal fee (atomic units of usdcMint), capped on-chain at $5. */
  withdrawalFeeAtomic: bigint;
  /** Wallet whose usdcMint ATA receives the fee leg. */
  feeTreasury: PublicKey;
  /** Spread engine: the protocol's share of COLLECTED interest, bps (capped
   *  on-chain at 5_000). Settlement builders MUST price the treasury leg from
   *  here — the program binds leg amounts against THESE bytes. */
  interestTakeBps: number;
  /** Penny lock (K-T1 #77): the operator's INTENT knob — max un-crystallized
   *  seller tail at risk to buyer abandonment, atomic USDC. RAW on-chain value:
   *  0 means "unset". Do NOT consume this directly — call
   *  effectiveMaxSellerAtRiskAtomic, which owns the 0→default substitution. */
  maxSellerAtRiskAtomic: bigint;
}

/** The canonical read of the penny-lock knob: 0 on-chain means "unset" and
 *  substitutes to MAX_SELLER_AT_RISK_DEFAULT (10_000 = $0.01). This
 *  substitution lives HERE, once — every consumer (facilitator engine, future
 *  surfaces) MUST derive its threshold from this helper, never re-implement
 *  the 0-check, so the semantics can never fork across surfaces. Mirrors the
 *  program's documented ZERO semantics (state.rs::max_seller_at_risk_atomic)
 *  and the max_depth_override 0-means-default precedent. */
export function effectiveMaxSellerAtRiskAtomic(
  config: Pick<GraphConfigOnchain, 'maxSellerAtRiskAtomic'>,
): bigint {
  return config.maxSellerAtRiskAtomic === 0n
    ? MAX_SELLER_AT_RISK_DEFAULT
    : config.maxSellerAtRiskAtomic;
}

const GRAPH_CONFIG_V2_LEN = 221;

export function parseGraphConfigData(data: Buffer): GraphConfigOnchain {
  if (data.length < GRAPH_CONFIG_V2_LEN) {
    throw new Error(
      `graph_config not migrated to V2 (len ${data.length}, need ${GRAPH_CONFIG_V2_LEN})`,
    );
  }
  return {
    version: data.readUInt8(8),
    adminAuthority: new PublicKey(data.subarray(10, 42)),
    pauseAuthority: new PublicKey(data.subarray(42, 74)),
    paused: data.readUInt8(74) === 1,
    usdcMint: new PublicKey(data.subarray(85, 117)),
    withdrawalFeeAtomic: data.readBigUInt64LE(117),
    feeTreasury: new PublicKey(data.subarray(125, 157)),
    interestTakeBps: data.readUInt16LE(157),
    maxSellerAtRiskAtomic: data.readBigUInt64LE(159),
  };
}

export async function readGraphConfigOnchain(
  connection: Connection,
): Promise<GraphConfigOnchain> {
  const [pda] = deriveGraphConfigPda();
  const info = await connection.getAccountInfo(pda);
  if (!info) throw new Error('graph_config account not found on-chain');
  return parseGraphConfigData(Buffer.from(info.data));
}
