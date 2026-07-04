import { describe, test, expect } from 'vitest';
import { Connection, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { drawCredit, repayCredit, seizeCollateral } from '../src/tab/credit.js';
import { PRINCIPAL_NODE_DISCRIMINATOR, DISCRIMINATORS } from '../src/constants/index.js';
import { deriveGraphConfigPda } from '../src/credit/derive.js';

const VAULT = new PublicKey('SysvarC1ock11111111111111111111111111111111');
const FIN_SWIG = new PublicKey('SysvarRent111111111111111111111111111111111');
const USER_SWIG = new PublicKey('So11111111111111111111111111111111111111112');
const DEST = new PublicKey('11111111111111111111111111111111');
const AUTH = new PublicKey('Ed25519SigVerify111111111111111111111111111');
const COLLATERAL = new PublicKey('SysvarStakeHistory1111111111111111111111111');
const NODE = PublicKey.unique();
const CTRL = PublicKey.unique();
const ROOTATT = PublicKey.unique();

// Kit-faithful fake: @swig-wallet/kit's getSignInstructions returns its
// preInstructions IN the ordered output, so the fake echoes vaultIx FIRST.
// Mis-modeling this (returning only the SignV2) is how the double-include bug
// hid — drawCredit/repayCredit/seizeCollateral used to re-prepend vaultIx, so
// the real kit ran the vault ix TWICE (caught for settleTab/instantPayout in
// 5d54497; the credit verbs were the same class, fixed here).
const markerData = (b: number) => async (a: any) =>
  [a.vaultIx, new TransactionInstruction({ programId: FIN_SWIG, keys: [], data: Buffer.from([b]) })];

/** Count ixs whose first 8 data bytes match `disc` (the vault verb must appear once). */
function discCount(ixs: TransactionInstruction[], disc: number[]): number {
  return ixs.filter((ix) => ix.data.length >= 8 && disc.every((bb, i) => ix.data[i] === bb)).length;
}

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
    u64(5_000_000n),             // borrowed (a live draw so clamps don't zero)
    u64(5_000_000n),             // subtree_draw
    Buffer.from([0]),            // borrow_recovery_at None
    u64(0n),                     // shortfall
    Buffer.from([0]),            // frozen
    u32(0),                      // child_count
    u64(0n),                     // accrued_fee
    u16(0),                      // rate_bps (0 ⇒ zero interest; math parity lives in accrual.test.ts)
    i64(0n),                     // last_accrual
    CTRL.toBuffer(),             // financier (any pubkey)
  ]);
}

// GraphConfig V2 buffer (221 bytes): version 2, take_bps 0 ⇒ single-leg settlements.
function graphConfigBuf(): Buffer {
  const b = Buffer.alloc(221);
  b.writeUInt8(2, 8);              // version = V2
  DEST.toBuffer().copy(b, 85);     // usdc_mint (any)
  CTRL.toBuffer().copy(b, 125);    // fee_treasury (any)
  b.writeUInt16LE(0, 157);         // interest_take_bps = 0
  return b;
}

function mockConn(): Connection {
  const byKey = new Map<string, Buffer>([
    [VAULT.toBase58(), vaultBuf(NODE)],
    [NODE.toBase58(), rootNodeBuf()],
    [deriveGraphConfigPda()[0].toBase58(), graphConfigBuf()],
  ]);
  return {
    getAccountInfo: async (pk: PublicKey) => {
      const data = byKey.get(pk.toBase58());
      return data ? { data } : null;
    },
    // spread engine: the wrappers source accrual_ts from the CHAIN clock and
    // (seize) the LIVE collateral balance.
    getSlot: async () => 1,
    getBlockTime: async () => 1_751_600_000,
    getTokenAccountBalance: async () => ({ value: { amount: '2000000' } }),
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
    // REGRESSION PIN: draw_credit must appear EXACTLY once (double-include reverts).
    expect(discCount(ixs, DISCRIMINATORS.draw_credit)).toBe(1);
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
    // REGRESSION PIN: repay_credit must appear EXACTLY once (double-include reverts).
    expect(discCount(ixs, DISCRIMINATORS.repay_credit)).toBe(1);
  });

  test('seizeCollateral composes seize_collateral + SignV2 from the USER swig', async () => {
    let sawSwig: PublicKey | undefined;
    let sawTransfers: any[] | undefined;
    const ixs = await seizeCollateral({
      connection: mockConn(), userVaultPda: VAULT, userSwig: USER_SWIG, collateralAta: COLLATERAL,
      dexterAuthority: AUTH, financierAta: DEST, feePayer: DEST,
      assembleSignV2: async (a: any) => { sawSwig = a.swigAddress; sawTransfers = a.transfers; return markerData(0xf)(a); },
    });
    expect(sawSwig!.equals(USER_SWIG)).toBe(true);  // seize funds from USER
    expect(sawTransfers![0].destinationAta.equals(DEST)).toBe(true);  // → financier ATA
    expect(sawTransfers![0].amount).toBe(2_000_000n);  // min(borrowed, live collateral) — quoted, not caller-supplied
    expect(ixs[0].keys[3].pubkey.equals(NODE)).toBe(true);
    expect(Array.from(ixs[ixs.length - 1].data)).toEqual([0xf]);
    expect(ixs.length).toBeGreaterThanOrEqual(2);  // [vaultIx, ...signV2]
    // REGRESSION PIN: seize_collateral must appear EXACTLY once (double-include reverts).
    expect(discCount(ixs, DISCRIMINATORS.seize_collateral)).toBe(1);
  });
});
