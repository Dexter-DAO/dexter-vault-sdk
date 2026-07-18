/**
 * swap_for_carry op message — the 111-byte intent the passkey endorses.
 * Lives in messages/ (browser-light barrel): surfaces rebuild + verify these
 * bytes client-side before signing; the server-side instruction assembly in
 * instructions/swapForCarry.ts imports from here.
 *
 * Layout (MUST mirror swap_for_carry.rs byte-exactly):
 *   "swap_for_carry" || vault(32) || direction(1) || amount_in u64 LE ||
 *   min_out u64 LE || base_mint(32) || nonce u64 LE || expiry_slot u64 LE
 * Vault binding right after the tag is the GATE-1 cross-vault-replay fix.
 * The WebAuthn challenge is sha256 of these bytes.
 */
import { PublicKey } from '@solana/web3.js';

export interface SwapIntent {
  vault: PublicKey;
  /** 0 = buy (USDC -> base), 1 = sell. */
  direction: number;
  /** Exact input the route must spend (ExactIn — program-enforced). */
  amountIn: bigint;
  /** The user's signed slippage floor — set TIGHT. */
  minOut: bigint;
  baseMint: PublicKey;
  /** Must equal the bracket's current nonce at execution. */
  nonce: bigint;
  /** Last valid execution slot. */
  expirySlot: bigint;
}

function u64le(v: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return b;
}

export function buildSwapForCarryMessage(i: SwapIntent): Uint8Array {
  const tag = new TextEncoder().encode('swap_for_carry'); // 14 bytes
  const out = new Uint8Array(111);
  let o = 0;
  out.set(tag, o); o += tag.length;
  out.set(i.vault.toBytes(), o); o += 32;
  out[o] = i.direction; o += 1;
  out.set(u64le(i.amountIn), o); o += 8;
  out.set(u64le(i.minOut), o); o += 8;
  out.set(i.baseMint.toBytes(), o); o += 32;
  out.set(u64le(i.nonce), o); o += 8;
  out.set(u64le(i.expirySlot), o); o += 8;
  if (o !== 111) throw new Error(`swap_for_carry op message must be 111 bytes, got ${o}`);
  return out;
}
