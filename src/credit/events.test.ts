import { PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';

import { bs58 } from '../grant/bs58.js';
import {
  EVENT_IX_TAG,
  decodeSpreadEvent,
  decodeSpreadEventsFromTransaction,
} from './events.js';

const PROGRAM = new PublicKey('Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc');

function u64(v: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return b;
}
function cat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const NODE = PublicKey.unique();
const ROOT = PublicKey.unique();
const REPAID_DISC = new Uint8Array([149, 202, 141, 22, 128, 189, 173, 27]);
const SEIZED_DISC = new Uint8Array([165, 149, 146, 90, 242, 23, 11, 168]);

// amount 1000000951, borrowed 0, principal 1e9, interest 951, cut 237, fee-after 0
const repaidPayload = cat(
  REPAID_DISC, NODE.toBytes(), ROOT.toBytes(),
  u64(1_000_000_951n), u64(0n), u64(1_000_000_000n), u64(951n), u64(237n), u64(0n),
);

describe('decodeSpreadEvent', () => {
  it('decodes CreditRepaid to the atomic unit', () => {
    const ev = decodeSpreadEvent(repaidPayload);
    expect(ev?.kind).toBe('creditRepaid');
    if (ev?.kind !== 'creditRepaid') throw new Error('unreachable');
    expect(ev.node.equals(NODE)).toBe(true);
    expect(ev.root.equals(ROOT)).toBe(true);
    expect(ev.amount).toBe(1_000_000_951n);
    expect(ev.newBorrowed).toBe(0n);
    expect(ev.principalPaid).toBe(1_000_000_000n);
    expect(ev.interestPaid).toBe(951n);
    expect(ev.treasuryCut).toBe(237n);
    expect(ev.newAccruedFee).toBe(0n);
  });

  it('decodes CollateralSeized', () => {
    const p = cat(SEIZED_DISC, NODE.toBytes(), ROOT.toBytes(), u64(500n), u64(100n), u64(217n));
    const ev = decodeSpreadEvent(p);
    expect(ev?.kind).toBe('collateralSeized');
    if (ev?.kind !== 'collateralSeized') throw new Error('unreachable');
    expect(ev.amount).toBe(500n);
    expect(ev.interestSeized).toBe(100n);
    expect(ev.interestWrittenOff).toBe(217n);
  });

  it('returns null for an unknown event discriminator', () => {
    expect(decodeSpreadEvent(cat(new Uint8Array(8).fill(9), NODE.toBytes()))).toBeNull();
  });

  it('throws loudly on a layout mismatch', () => {
    // Truncated: the DataView read runs out of bounds — loud, never silent.
    expect(() => decodeSpreadEvent(repaidPayload.subarray(0, repaidPayload.length - 4))).toThrow();
    // Padded: every field decodes but trailing bytes remain — the done() gate.
    expect(() => decodeSpreadEvent(cat(repaidPayload, new Uint8Array(4)))).toThrow(/layout mismatch/);
  });
});

describe('decodeSpreadEventsFromTransaction', () => {
  const innerData = bs58.encode(cat(EVENT_IX_TAG, repaidPayload));
  const fakeTx = (programIdIndex: number, keys: PublicKey[]) => ({
    meta: {
      innerInstructions: [
        { instructions: [{ programIdIndex, data: innerData }] },
      ],
    },
    transaction: { message: { staticAccountKeys: keys } },
  });

  it('extracts the event when the inner CPI targets the program', () => {
    const evs = decodeSpreadEventsFromTransaction(fakeTx(1, [PublicKey.unique(), PROGRAM]), PROGRAM);
    expect(evs).toHaveLength(1);
    expect(evs[0].kind).toBe('creditRepaid');
  });

  it('ignores inner CPIs of other programs and non-event data', () => {
    const other = PublicKey.unique();
    expect(decodeSpreadEventsFromTransaction(fakeTx(1, [PublicKey.unique(), other]), PROGRAM)).toHaveLength(0);
    const noTag = {
      meta: { innerInstructions: [{ instructions: [{ programIdIndex: 0, data: bs58.encode(repaidPayload) }] }] },
      transaction: { message: { staticAccountKeys: [PROGRAM] } },
    };
    expect(decodeSpreadEventsFromTransaction(noTag, PROGRAM)).toHaveLength(0);
  });

  it('resolves programIdIndex through loadedAddresses (v0 ALT transactions)', () => {
    const tx = {
      meta: {
        innerInstructions: [{ instructions: [{ programIdIndex: 2, data: innerData }] }],
        loadedAddresses: { writable: [PublicKey.unique()], readonly: [PROGRAM] },
      },
      transaction: { message: { staticAccountKeys: [PublicKey.unique()] } },
    };
    const evs = decodeSpreadEventsFromTransaction(tx, PROGRAM);
    expect(evs).toHaveLength(1);
  });
});
