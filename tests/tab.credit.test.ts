import { describe, test, expect } from 'vitest';
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { drawCredit, repayCredit, seizeCollateral } from '../src/tab/credit.js';

const VAULT = new PublicKey('SysvarC1ock11111111111111111111111111111111');
const FIN_SWIG = new PublicKey('SysvarRent111111111111111111111111111111111');
const USER_SWIG = new PublicKey('So11111111111111111111111111111111111111112');
const MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const DEST = new PublicKey('11111111111111111111111111111111');
const AUTH = new PublicKey('Ed25519SigVerify111111111111111111111111111');
const markerData = (b: number) => async (_a: any) =>
  [new TransactionInstruction({ programId: FIN_SWIG, keys: [], data: Buffer.from([b]) })];

describe('credit verbs', () => {
  test('drawCredit composes draw_credit + SignV2 from the FINANCIER swig', async () => {
    let sawSwig: PublicKey | undefined;
    let sawTransfers: any[] | undefined;
    const ixs = await drawCredit({
      connection: {} as any, userVaultPda: VAULT, financierSwig: FIN_SWIG,
      amount: 3_000_000n, recoveryWindowSeconds: 300n, dexterAuthority: AUTH,
      sellerAta: DEST, feePayer: DEST,
      assembleSignV2: async (a: any) => { sawSwig = a.swigAddress; sawTransfers = a.transfers; return markerData(0xd)(a); },
    });
    expect(sawSwig!.equals(FIN_SWIG)).toBe(true);  // draw funds from FINANCIER
    expect(sawTransfers![0].destinationAta.equals(DEST)).toBe(true);  // → seller ATA
    expect(sawTransfers![0].amount).toBe(3_000_000n);
    expect(Array.from(ixs[ixs.length - 1].data)).toEqual([0xd]);
    expect(ixs.length).toBeGreaterThanOrEqual(2);  // [vaultIx, ...signV2]
  });

  test('repayCredit composes repay_credit + SignV2 from the USER swig', async () => {
    let sawSwig: PublicKey | undefined;
    let sawTransfers: any[] | undefined;
    const ixs = await repayCredit({
      connection: {} as any, userVaultPda: VAULT, userSwig: USER_SWIG,
      amount: 1_000_000n, dexterAuthority: AUTH, financierAta: DEST, feePayer: DEST,
      assembleSignV2: async (a: any) => { sawSwig = a.swigAddress; sawTransfers = a.transfers; return markerData(0xe)(a); },
    });
    expect(sawSwig!.equals(USER_SWIG)).toBe(true);  // repay funds from USER
    expect(sawTransfers![0].destinationAta.equals(DEST)).toBe(true);  // → financier ATA
    expect(sawTransfers![0].amount).toBe(1_000_000n);
    expect(Array.from(ixs[ixs.length - 1].data)).toEqual([0xe]);
    expect(ixs.length).toBeGreaterThanOrEqual(2);  // [vaultIx, ...signV2]
  });

  test('seizeCollateral composes seize_collateral + SignV2 from the USER swig', async () => {
    let sawSwig: PublicKey | undefined;
    let sawTransfers: any[] | undefined;
    const ixs = await seizeCollateral({
      connection: {} as any, userVaultPda: VAULT, userSwig: USER_SWIG,
      dexterAuthority: AUTH, financierAta: DEST, feePayer: DEST, seizeAmount: 2_000_000n,
      assembleSignV2: async (a: any) => { sawSwig = a.swigAddress; sawTransfers = a.transfers; return markerData(0xf)(a); },
    });
    expect(sawSwig!.equals(USER_SWIG)).toBe(true);  // seize funds from USER
    expect(sawTransfers![0].destinationAta.equals(DEST)).toBe(true);  // → financier ATA
    expect(sawTransfers![0].amount).toBe(2_000_000n);  // the seizeAmount
    expect(Array.from(ixs[ixs.length - 1].data)).toEqual([0xf]);
    expect(ixs.length).toBeGreaterThanOrEqual(2);  // [vaultIx, ...signV2]
  });
});
