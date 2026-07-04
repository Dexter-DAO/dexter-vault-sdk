/**
 * Spread-engine settlement events — decoded straight from a confirmed
 * transaction's event-CPI inner instructions, no Anchor runtime needed.
 *
 * V7 settlement paths emit the authoritative principal/interest split
 * on-chain (`CreditRepaid.principal_paid` / `interest_paid` / `treasury_cut`),
 * making these events the PRIMARY ledger source — a before/after account
 * probe can be skewed by interest banked inside the transaction itself
 * (settle_accrual runs to the quoted accrual_ts), so collectors should prefer
 * the event fields and fall back to probes only when the event is unreadable.
 *
 * Layouts are fixed-size Borsh (no vecs/options), hand-decoded against
 * events.rs; discriminators are pinned from the generated IDL. A layout
 * change on-chain therefore fails loudly here (length check), never silently.
 */

import { PublicKey } from '@solana/web3.js';

import { bs58 } from '../grant/bs58.js';

/** Anchor `#[event_cpi]` marker: the first 8 bytes of the self-CPI's data. */
export const EVENT_IX_TAG = new Uint8Array([228, 69, 165, 46, 81, 203, 154, 29]);

const DISC = {
  creditDrawn: new Uint8Array([186, 180, 69, 137, 39, 179, 141, 166]),
  creditRepaid: new Uint8Array([149, 202, 141, 22, 128, 189, 173, 27]),
  collateralSeized: new Uint8Array([165, 149, 146, 90, 242, 23, 11, 168]),
  positionLiquidated: new Uint8Array([40, 107, 90, 214, 96, 30, 61, 128]),
} as const;

export interface CreditDrawnEvent {
  kind: 'creditDrawn';
  node: PublicKey;
  root: PublicKey;
  amount: bigint;
  newBorrowed: bigint;
  newSubtreeDraw: bigint;
  depth: number;
  accruedDelta: bigint;
  newAccruedFee: bigint;
  rateBps: number;
}

export interface CreditRepaidEvent {
  kind: 'creditRepaid';
  node: PublicKey;
  root: PublicKey;
  amount: bigint;
  newBorrowed: bigint;
  principalPaid: bigint;
  interestPaid: bigint;
  treasuryCut: bigint;
  newAccruedFee: bigint;
}

export interface CollateralSeizedEvent {
  kind: 'collateralSeized';
  node: PublicKey;
  root: PublicKey;
  amount: bigint;
  interestSeized: bigint;
  interestWrittenOff: bigint;
}

export interface PositionLiquidatedEvent {
  kind: 'positionLiquidated';
  node: PublicKey;
  root: PublicKey;
  seized: bigint;
  shortfall: bigint;
  interestSeized: bigint;
  interestWrittenOff: bigint;
}

export type SpreadEvent =
  | CreditDrawnEvent
  | CreditRepaidEvent
  | CollateralSeizedEvent
  | PositionLiquidatedEvent;

function eq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

class Reader {
  private o = 0;
  private readonly v: DataView;
  constructor(private readonly d: Uint8Array) {
    this.v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  }
  pubkey(): PublicKey {
    const k = new PublicKey(this.d.subarray(this.o, this.o + 32));
    this.o += 32;
    return k;
  }
  u64(): bigint {
    const x = this.v.getBigUint64(this.o, true);
    this.o += 8;
    return x;
  }
  u16(): number {
    const x = this.v.getUint16(this.o, true);
    this.o += 2;
    return x;
  }
  u8(): number {
    const x = this.v.getUint8(this.o);
    this.o += 1;
    return x;
  }
  done(name: string): void {
    if (this.o !== this.d.length) {
      throw new Error(`${name}: layout mismatch — decoded ${this.o} of ${this.d.length} bytes (on-chain event layout changed?)`);
    }
  }
}

/** Decode ONE event payload (the bytes AFTER the 8-byte EVENT_IX_TAG: the
 *  8-byte event discriminator + Borsh body). Returns null for event types this
 *  module does not know (other program events ride the same CPI channel). */
export function decodeSpreadEvent(payload: Uint8Array): SpreadEvent | null {
  if (payload.length < 8) return null;
  const disc = payload.subarray(0, 8);
  const body = payload.subarray(8);
  const r = new Reader(body);
  if (eq(disc, DISC.creditRepaid)) {
    const ev: CreditRepaidEvent = {
      kind: 'creditRepaid',
      node: r.pubkey(), root: r.pubkey(),
      amount: r.u64(), newBorrowed: r.u64(),
      principalPaid: r.u64(), interestPaid: r.u64(),
      treasuryCut: r.u64(), newAccruedFee: r.u64(),
    };
    r.done('CreditRepaid');
    return ev;
  }
  if (eq(disc, DISC.collateralSeized)) {
    const ev: CollateralSeizedEvent = {
      kind: 'collateralSeized',
      node: r.pubkey(), root: r.pubkey(),
      amount: r.u64(), interestSeized: r.u64(), interestWrittenOff: r.u64(),
    };
    r.done('CollateralSeized');
    return ev;
  }
  if (eq(disc, DISC.positionLiquidated)) {
    const ev: PositionLiquidatedEvent = {
      kind: 'positionLiquidated',
      node: r.pubkey(), root: r.pubkey(),
      seized: r.u64(), shortfall: r.u64(),
      interestSeized: r.u64(), interestWrittenOff: r.u64(),
    };
    r.done('PositionLiquidated');
    return ev;
  }
  if (eq(disc, DISC.creditDrawn)) {
    const ev: CreditDrawnEvent = {
      kind: 'creditDrawn',
      node: r.pubkey(), root: r.pubkey(),
      amount: r.u64(), newBorrowed: r.u64(), newSubtreeDraw: r.u64(),
      depth: r.u8(), accruedDelta: r.u64(), newAccruedFee: r.u64(),
      rateBps: r.u16(),
    };
    r.done('CreditDrawn');
    return ev;
  }
  return null;
}

/** Minimal structural slice of web3.js's getTransaction() result — typed
 *  loosely so any web3 version (and test fakes) fit. */
export interface ConfirmedTransactionLike {
  meta?: {
    innerInstructions?: Array<{
      instructions: Array<{ programIdIndex: number; data: string }>;
    }> | null;
    loadedAddresses?: { writable: PublicKey[]; readonly: PublicKey[] } | null;
  } | null;
  transaction: {
    message: {
      // legacy + v0 messages both expose the static keys this way in web3.js
      staticAccountKeys?: PublicKey[];
      accountKeys?: PublicKey[];
    };
  };
}

/** Extract every spread-engine event from a confirmed transaction (the result
 *  of `connection.getTransaction(sig, { maxSupportedTransactionVersion: 0 })`).
 *  Only inner instructions invoking `programId` with the event-CPI tag are
 *  considered; unknown events are skipped. */
export function decodeSpreadEventsFromTransaction(
  tx: ConfirmedTransactionLike,
  programId: PublicKey,
): SpreadEvent[] {
  const out: SpreadEvent[] = [];
  const msg = tx.transaction.message;
  const staticKeys = msg.staticAccountKeys ?? msg.accountKeys ?? [];
  const loaded = tx.meta?.loadedAddresses;
  // Runtime account-key order: static, then loaded writable, then loaded readonly.
  const allKeys = [...staticKeys, ...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])];
  for (const group of tx.meta?.innerInstructions ?? []) {
    for (const ix of group.instructions) {
      const pid = allKeys[ix.programIdIndex];
      if (!pid || !pid.equals(programId)) continue;
      let data: Uint8Array;
      try {
        data = bs58.decode(ix.data);
      } catch {
        continue;
      }
      if (data.length < EVENT_IX_TAG.length || !eq(data.subarray(0, 8), EVENT_IX_TAG)) continue;
      const ev = decodeSpreadEvent(data.subarray(8));
      if (ev) out.push(ev);
    }
  }
  return out;
}
