import { describe, it, expect } from 'vitest';
import { Connection, PublicKey } from '@solana/web3.js';
import { decodePrincipalNode, walkAncestors } from './accountReader.js';
import { PRINCIPAL_NODE_DISCRIMINATOR } from '../constants/index.js';

// ── PrincipalNode buffer builder (mirrors programs/dexter-vault/src/state.rs) ──
//   8 disc | version u8 | bump u8 | node_id[32] | controller pk | parent Opt<pk>
//   | root_attestation Opt<pk> | cap{rate_amount u64, period_secs u32, bucket u64,
//   last_refill i64, ceiling Opt<u64>, burst_multiple u8} | borrowed u64
//   | subtree_draw u64 | borrow_recovery_at Opt<i64> | shortfall u64 | frozen bool
//   | child_count u32 | accrued_fee u64 | rate_bps u16 | last_accrual i64
//   | financier pk
function buildNodeBuffer(opts: {
  version?: number;
  bump?: number;
  nodeId: Uint8Array;
  controller: PublicKey;
  parent: PublicKey | null;
  rootAttestation: PublicKey | null;
  rateAmount?: bigint;
  periodSecs?: number;
  bucket?: bigint;
  lastRefill?: bigint;
  ceiling?: bigint | null;
  burstMultiple?: number;
  borrowed?: bigint;
  subtreeDraw?: bigint;
  borrowRecoveryAt?: bigint | null;
  shortfall?: bigint;
  frozen?: boolean;
  childCount?: number;
  accruedFee?: bigint;
  rateBps?: number;
  lastAccrual?: bigint;
  financier?: PublicKey;
}): Buffer {
  const u64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };
  const i64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigInt64LE(v); return b; };
  const u32 = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
  const u16 = (v: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
  const opt = (present: boolean, body: Buffer) =>
    present ? Buffer.concat([Buffer.from([1]), body]) : Buffer.from([0]);

  const parts: Buffer[] = [
    Buffer.from(PRINCIPAL_NODE_DISCRIMINATOR),
    Buffer.from([opts.version ?? 1]),
    Buffer.from([opts.bump ?? 255]),
    Buffer.from(opts.nodeId),
    opts.controller.toBuffer(),
    opt(opts.parent !== null, opts.parent?.toBuffer() ?? Buffer.alloc(32)),
    opt(opts.rootAttestation !== null, opts.rootAttestation?.toBuffer() ?? Buffer.alloc(32)),
    // cap
    u64(opts.rateAmount ?? 0n),
    u32(opts.periodSecs ?? 0),
    u64(opts.bucket ?? 0n),
    i64(opts.lastRefill ?? 0n),
    opt((opts.ceiling ?? null) !== null, u64(opts.ceiling ?? 0n)),
    Buffer.from([opts.burstMultiple ?? 0]),
    // tail
    u64(opts.borrowed ?? 0n),
    u64(opts.subtreeDraw ?? 0n),
    opt((opts.borrowRecoveryAt ?? null) !== null, i64(opts.borrowRecoveryAt ?? 0n)),
    u64(opts.shortfall ?? 0n),
    Buffer.from([opts.frozen ? 1 : 0]),
    u32(opts.childCount ?? 0),
    u64(opts.accruedFee ?? 0n),
    u16(opts.rateBps ?? 0),
    i64(opts.lastAccrual ?? 0n),
    (opts.financier ?? PublicKey.default).toBuffer(),
  ];
  return Buffer.concat(parts);
}

const CTRL = new PublicKey('11111111111111111111111111111112');
const PARENT = new PublicKey('11111111111111111111111111111113');
const ROOTATT = new PublicKey('11111111111111111111111111111114');

function nodeId(n: number): Uint8Array {
  const a = new Uint8Array(32);
  a[0] = n;
  return a;
}

describe('decodePrincipalNode', () => {
  it('round-trips a delegate node (parent Some, root None, ceiling Some, recovery armed)', () => {
    const buf = buildNodeBuffer({
      version: 1, bump: 254, nodeId: nodeId(7), controller: CTRL,
      parent: PARENT, rootAttestation: null,
      rateAmount: 1_000n, periodSecs: 60, bucket: 500n, lastRefill: 1_700_000_000n,
      ceiling: 9_999n, burstMultiple: 3,
      borrowed: 250n, subtreeDraw: 800n, borrowRecoveryAt: 1_900_000_000n,
      shortfall: 0n, frozen: true, childCount: 2, accruedFee: 11n,
      rateBps: 250, lastAccrual: 1_700_000_500n, financier: ROOTATT,
    });
    const n = decodePrincipalNode(buf);
    expect(n.version).toBe(1);
    expect(n.bump).toBe(254);
    expect(Buffer.from(n.nodeId).equals(Buffer.from(nodeId(7)))).toBe(true);
    expect(n.controller).toBe(CTRL.toBase58());
    expect(n.parent).toBe(PARENT.toBase58());
    expect(n.rootAttestation).toBeNull();
    expect(n.cap.rateAmount).toBe('1000');
    expect(n.cap.periodSecs).toBe(60);
    expect(n.cap.bucket).toBe('500');
    expect(n.cap.lastRefill).toBe(1_700_000_000);
    expect(n.cap.ceiling).toBe('9999');
    expect(n.cap.burstMultiple).toBe(3);
    expect(n.borrowed).toBe('250');
    expect(n.subtreeDraw).toBe('800');
    expect(n.borrowRecoveryAt).toBe(1_900_000_000);
    expect(n.shortfall).toBe('0');
    expect(n.frozen).toBe(true);
    expect(n.childCount).toBe(2);
    expect(n.accruedFee).toBe('11');
    expect(n.rateBps).toBe(250);
    expect(n.lastAccrual).toBe(1_700_000_500);
    expect(n.financier).toBe(ROOTATT.toBase58());
  });

  it('round-trips a root node (parent None, root Some, ceiling None)', () => {
    const buf = buildNodeBuffer({
      nodeId: nodeId(1), controller: CTRL,
      parent: null, rootAttestation: ROOTATT, ceiling: null,
      borrowed: 0n, subtreeDraw: 1234n,
    });
    const n = decodePrincipalNode(buf);
    expect(n.parent).toBeNull();
    expect(n.rootAttestation).toBe(ROOTATT.toBase58());
    expect(n.cap.ceiling).toBeNull();
    expect(n.subtreeDraw).toBe('1234');
  });
});

describe('walkAncestors', () => {
  it('resolves a 3-deep chain child→parent up to the root', async () => {
    // leaf(A) → mid(B) → root(C). parent pointers are stored pubkeys.
    const A = PublicKey.unique();
    const B = PublicKey.unique();
    const C = PublicKey.unique();
    const byKey = new Map<string, Buffer>([
      [A.toBase58(), buildNodeBuffer({ nodeId: nodeId(1), controller: CTRL, parent: B, rootAttestation: null })],
      [B.toBase58(), buildNodeBuffer({ nodeId: nodeId(2), controller: CTRL, parent: C, rootAttestation: null })],
      [C.toBase58(), buildNodeBuffer({ nodeId: nodeId(3), controller: CTRL, parent: null, rootAttestation: ROOTATT })],
    ]);
    const conn = {
      getAccountInfo: async (pk: PublicKey) => {
        const data = byKey.get(pk.toBase58());
        return data ? { data } : null;
      },
    } as unknown as Connection;

    const path = await walkAncestors(conn, A);
    expect(path.map((p) => p.toBase58())).toEqual([A.toBase58(), B.toBase58(), C.toBase58()]);
  });

  it('returns a single-element path for a parent-less root', async () => {
    const R = new PublicKey('11111111111111111111111111111115');
    const conn = {
      getAccountInfo: async () => ({
        data: buildNodeBuffer({ nodeId: nodeId(9), controller: CTRL, parent: null, rootAttestation: ROOTATT }),
      }),
    } as unknown as Connection;
    const path = await walkAncestors(conn, R);
    expect(path.map((p) => p.toBase58())).toEqual([R.toBase58()]);
  });
});
