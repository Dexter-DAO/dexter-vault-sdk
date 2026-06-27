import { describe, test, expect } from 'vitest';
import { Connection, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { drawCredit, repayCredit, seizeCollateral } from '../src/tab/credit.js';
import { PRINCIPAL_NODE_DISCRIMINATOR } from '../src/constants/index.js';

const VAULT = new PublicKey('SysvarC1ock11111111111111111111111111111111');
const FIN_SWIG = new PublicKey('SysvarRent111111111111111111111111111111111');
const USER_SWIG = new PublicKey('So11111111111111111111111111111111111111112');
const DEST = new PublicKey('11111111111111111111111111111111');
const AUTH = new PublicKey('Ed25519SigVerify111111111111111111111111111');
const COLLATERAL = new PublicKey('SysvarStakeHistory1111111111111111111111111');
const NODE = PublicKey.unique();
const CTRL = PublicKey.unique();
const ROOTATT = PublicKey.unique();

const markerData = (b: number) => async (_a: any) =>
  [new TransactionInstruction({ programId: FIN_SWIG, keys: [], data: Buffer.from([b]) })];

// Vault buffer (no withdrawal): outstanding @149, crystallized, settled, node @173.
function vaultBuf(node: PublicKey): Buffer {
  const head = Buffer.alloc(149);
  head.writeUInt8(6, 8);          // version
  VAULT.toBuffer().copy(head, 43); // swig_address (any)
  AUTH.toBuffer().copy(head, 116); // dexter_authority
  head.writeUInt8(0, 148);        // live_session_count
  const u64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };
  return Buffer.concat([head, u64(0n), u64(0n), u64(0n), node.toBuffer()]);
}

// A parent-less rooted PrincipalNode (so walkAncestors → [node], chain → []).
function rootNodeBuf(): Buffer {
  const u64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };
  const i64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigInt64LE(v); return b; };
  const u32 = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
  const u16 = (v: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
  return Buffer.concat([
    Buffer.from(PRINCIPAL_NODE_DISCRIMINATOR),
    Buffer.from([1]),            // version
    Buffer.from([255]),          // bump
    Buffer.alloc(32),            // node_id
    CTRL.toBuffer(),             // controller
    Buffer.from([0]),            // parent = None
    Buffer.concat([Buffer.from([1]), ROOTATT.toBuffer()]), // root_attestation = Some
    u64(0n), u32(60), u64(0n), i64(0n), Buffer.from([0]), Buffer.from([0]), // cap (ceiling None)
    u64(0n),                     // borrowed
    u64(0n),                     // subtree_draw
    Buffer.from([0]),            // borrow_recovery_at None
    u64(0n),                     // shortfall
    Buffer.from([0]),            // frozen
    u32(0),                      // child_count
    u64(0n),                     // accrued_fee
    u16(0),                      // rate_bps
    i64(0n),                     // last_accrual
  ]);
}

function mockConn(): Connection {
  const byKey = new Map<string, Buffer>([
    [VAULT.toBase58(), vaultBuf(NODE)],
    [NODE.toBase58(), rootNodeBuf()],
  ]);
  return {
    getAccountInfo: async (pk: PublicKey) => {
      const data = byKey.get(pk.toBase58());
      return data ? { data } : null;
    },
  } as unknown as Connection;
}

describe('credit verbs', () => {
  test('drawCredit composes draw_credit (drawing_node wired) + SignV2 from the FINANCIER swig', async () => {
    let sawSwig: PublicKey | undefined;
    let sawTransfers: any[] | undefined;
    const ixs = await drawCredit({
      connection: mockConn(), userVaultPda: VAULT, financierSwig: FIN_SWIG,
      amount: 3_000_000n, recoveryWindowSeconds: 300n, dexterAuthority: AUTH,
      sellerAta: DEST, feePayer: DEST,
      assembleSignV2: async (a: any) => { sawSwig = a.swigAddress; sawTransfers = a.transfers; return markerData(0xd)(a); },
    });
    expect(sawSwig!.equals(FIN_SWIG)).toBe(true);  // draw funds from FINANCIER
    expect(sawTransfers![0].destinationAta.equals(DEST)).toBe(true);  // → seller ATA
    expect(sawTransfers![0].amount).toBe(3_000_000n);
    // drawing_node resolved from vault.node and placed at index 3
    expect(ixs[0].keys[3].pubkey.equals(NODE)).toBe(true);
    expect(Array.from(ixs[ixs.length - 1].data)).toEqual([0xd]);
    expect(ixs.length).toBeGreaterThanOrEqual(2);  // [vaultIx, ...signV2]
  });

  test('repayCredit composes repay_credit + SignV2 from the USER swig', async () => {
    let sawSwig: PublicKey | undefined;
    let sawTransfers: any[] | undefined;
    const ixs = await repayCredit({
      connection: mockConn(), userVaultPda: VAULT, userSwig: USER_SWIG,
      amount: 1_000_000n, dexterAuthority: AUTH, financierAta: DEST, feePayer: DEST,
      assembleSignV2: async (a: any) => { sawSwig = a.swigAddress; sawTransfers = a.transfers; return markerData(0xe)(a); },
    });
    expect(sawSwig!.equals(USER_SWIG)).toBe(true);  // repay funds from USER
    expect(sawTransfers![0].destinationAta.equals(DEST)).toBe(true);  // → financier ATA
    expect(sawTransfers![0].amount).toBe(1_000_000n);
    expect(ixs[0].keys[3].pubkey.equals(NODE)).toBe(true);
    expect(Array.from(ixs[ixs.length - 1].data)).toEqual([0xe]);
    expect(ixs.length).toBeGreaterThanOrEqual(2);  // [vaultIx, ...signV2]
  });

  test('seizeCollateral composes seize_collateral + SignV2 from the USER swig', async () => {
    let sawSwig: PublicKey | undefined;
    let sawTransfers: any[] | undefined;
    const ixs = await seizeCollateral({
      connection: mockConn(), userVaultPda: VAULT, userSwig: USER_SWIG, collateralAta: COLLATERAL,
      dexterAuthority: AUTH, financierAta: DEST, feePayer: DEST, seizeAmount: 2_000_000n,
      assembleSignV2: async (a: any) => { sawSwig = a.swigAddress; sawTransfers = a.transfers; return markerData(0xf)(a); },
    });
    expect(sawSwig!.equals(USER_SWIG)).toBe(true);  // seize funds from USER
    expect(sawTransfers![0].destinationAta.equals(DEST)).toBe(true);  // → financier ATA
    expect(sawTransfers![0].amount).toBe(2_000_000n);  // the seizeAmount
    expect(ixs[0].keys[3].pubkey.equals(NODE)).toBe(true);
    expect(Array.from(ixs[ixs.length - 1].data)).toEqual([0xf]);
    expect(ixs.length).toBeGreaterThanOrEqual(2);  // [vaultIx, ...signV2]
  });
});
