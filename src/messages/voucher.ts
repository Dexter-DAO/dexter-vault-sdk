/**
 * 44-byte voucher payload — the canonical bytes the session key signs per
 * stream chunk.
 *
 * Layout:
 *    0   32  channel_id
 *   32    8  cumulative_amount (u64 LE)
 *   40    4  sequence_number (u32 LE)
 *                                    ───
 *                                    44
 *
 * NOTE: production calls this under two names — `voucherPayloadMessage`
 * (x402) and `buildVoucherMessage` (dexter-api, dexter-facilitator). Both
 * are exported here, pointing at the same function. Don't bikeshed.
 */

export interface VoucherPayloadBytes {
  channelId: Uint8Array;
  cumulativeAmount: bigint;
  sequenceNumber: number;
}

export function voucherPayloadMessage(p: VoucherPayloadBytes): Uint8Array {
  if (p.channelId.length !== 32) {
    throw new Error(`channelId must be 32 bytes, got ${p.channelId.length}`);
  }
  const buf = new Uint8Array(44);
  const view = new DataView(buf.buffer);
  buf.set(p.channelId, 0);
  view.setBigUint64(32, p.cumulativeAmount, true);
  view.setUint32(40, p.sequenceNumber >>> 0, true);
  return buf;
}

/** Positional alias for the dexter-api/dexter-facilitator call shape. */
export function buildVoucherMessage(
  channelId: Uint8Array,
  cumulativeAmount: bigint,
  sequenceNumber: number,
): Uint8Array {
  return voucherPayloadMessage({ channelId, cumulativeAmount, sequenceNumber });
}
