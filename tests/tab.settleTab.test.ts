import { describe, test, expect } from 'vitest';
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { settleTab } from '../src/tab/settleTab.js';

const VAULT = new PublicKey('SysvarC1ock11111111111111111111111111111111');
const SWIG = new PublicKey('SysvarRent111111111111111111111111111111111');
const SELLER_ATA = new PublicKey('So11111111111111111111111111111111111111112');
const FEEPAYER = new PublicKey('11111111111111111111111111111111');

const sessionSigner = {
  publicKey: new Uint8Array(32).fill(7),
  sign: async (_m: Uint8Array) => new Uint8Array(64).fill(9),
};

describe('settleTab', () => {
  test('reads prior-spent, computes the delta, composes precompile + vault ix + SignV2', async () => {
    let assemblerSawDelta: bigint | undefined;
    const fakeAssemble = async (a: any) => {
      assemblerSawDelta = a.transfers[0].amount;
      return [new TransactionInstruction({ programId: SWIG, keys: [], data: Buffer.from([0x5a]) })];
    };
    const ixs = await settleTab({
      connection: {} as any,
      vaultPda: VAULT, swigAddress: SWIG,
      channelId: new Uint8Array(32).fill(1),
      cumulativeAmount: 5_000_000n, sequenceNumber: 3,
      sessionSigner, sellerAta: SELLER_ATA, feePayer: FEEPAYER,
      dexterAuthority: FEEPAYER,
      assembleSignV2: fakeAssemble,
      readPriorSpent: async () => 2_000_000n,
    });
    expect(assemblerSawDelta).toBe(3_000_000n); // 5,000,000 - 2,000,000
    expect(ixs.length).toBeGreaterThanOrEqual(3);
    expect(ixs[0].programId.equals(new PublicKey('Ed25519SigVerify111111111111111111111111111'))).toBe(true);
    expect(Array.from(ixs[ixs.length - 1].data)).toEqual([0x5a]);
  });

  test('rejects a non-monotonic settle (cumulative <= priorSpent)', async () => {
    await expect(
      settleTab({
        connection: {} as any, vaultPda: VAULT, swigAddress: SWIG,
        channelId: new Uint8Array(32).fill(1),
        cumulativeAmount: 2_000_000n, sequenceNumber: 3,
        sessionSigner, sellerAta: SELLER_ATA, feePayer: FEEPAYER,
        dexterAuthority: FEEPAYER,
        assembleSignV2: async () => [],
        readPriorSpent: async () => 2_000_000n,
      }),
    ).rejects.toThrow(/non-monotonic|cumulative/i);
  });

  test('propagates a no-active-session read error', async () => {
    await expect(
      settleTab({
        connection: {} as any, vaultPda: VAULT, swigAddress: SWIG,
        channelId: new Uint8Array(32).fill(1),
        cumulativeAmount: 5_000_000n, sequenceNumber: 3,
        sessionSigner, sellerAta: SELLER_ATA, feePayer: FEEPAYER,
        dexterAuthority: FEEPAYER,
        assembleSignV2: async () => [],
        readPriorSpent: async () => { throw new Error('settleTab: no active session on vault'); },
      }),
    ).rejects.toThrow(/no active session/);
  });
});
