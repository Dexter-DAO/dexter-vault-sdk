import { describe, test, expect, vi } from 'vitest';
import { Connection, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { settleTab } from '../src/tab/settleTab.js';
import { deriveSessionPda } from '../src/session/index.js';
import { SESSION_ACCOUNT_DISCRIMINATOR, SESSION_ACCOUNT_SIZE } from '../src/constants/index.js';

const VAULT = new PublicKey('SysvarC1ock11111111111111111111111111111111');
const SWIG = new PublicKey('SysvarRent111111111111111111111111111111111');
const SELLER_ATA = new PublicKey('So11111111111111111111111111111111111111112');
const FEEPAYER = new PublicKey('11111111111111111111111111111111');
const COUNTERPARTY = new PublicKey('SysvarS1otHashes111111111111111111111111111');
const FUTURE = 4_000_000_000;
const PAST = 1_000_000_000;

const sessionSigner = {
  publicKey: new Uint8Array(32).fill(7),
  sign: async (_m: Uint8Array) => new Uint8Array(64).fill(9),
};

const baseParams = {
  vaultPda: VAULT,
  swigAddress: SWIG,
  channelId: new Uint8Array(32).fill(1),
  sequenceNumber: 3,
  sessionSigner,
  sellerAta: SELLER_ATA,
  feePayer: FEEPAYER,
  dexterAuthority: FEEPAYER,
  allowedCounterparty: COUNTERPARTY,
};

/** Real 162-byte SessionAccount fixture (same pattern as tests/session.fetch.test.ts). */
function rawSession(opts: { version?: number; expiresAt?: number; spent?: bigint } = {}): Buffer {
  const data = Buffer.alloc(SESSION_ACCOUNT_SIZE);
  Buffer.from(SESSION_ACCOUNT_DISCRIMINATOR).copy(data, 0);
  data.writeUInt8(opts.version ?? 1, 8);
  data.writeUInt8(255, 9);
  VAULT.toBuffer().copy(data, 10);
  data.writeBigUInt64LE(50_000_000n, 74); // max_amount
  data.writeBigInt64LE(BigInt(opts.expiresAt ?? FUTURE), 82);
  COUNTERPARTY.toBuffer().copy(data, 90);
  data.writeBigUInt64LE(opts.spent ?? 2_000_000n, 126);
  return data;
}

function connWith(data: Buffer | null): Connection {
  return {
    getAccountInfo: vi.fn().mockResolvedValue(data ? { data } : null),
  } as unknown as Connection;
}

describe('settleTab', () => {
  test('reads prior-spent, computes the delta, composes precompile + vault ix + SignV2', async () => {
    let assemblerSawDelta: bigint | undefined;
    const fakeAssemble = async (a: any) => {
      assemblerSawDelta = a.transfers[0].amount;
      return [new TransactionInstruction({ programId: SWIG, keys: [], data: Buffer.from([0x5a]) })];
    };
    const ixs = await settleTab({
      ...baseParams,
      connection: {} as any,
      cumulativeAmount: 5_000_000n,
      assembleSignV2: fakeAssemble,
      readPriorSpent: async () => 2_000_000n,
    });
    expect(assemblerSawDelta).toBe(3_000_000n); // 5,000,000 - 2,000,000
    expect(ixs.length).toBeGreaterThanOrEqual(3);
    expect(ixs[0].programId.equals(new PublicKey('Ed25519SigVerify111111111111111111111111111'))).toBe(true);
    expect(Array.from(ixs[ixs.length - 1].data)).toEqual([0x5a]);

    // V6: the settle_tab_voucher ix carries the session PDA at index 3 (writable)
    // and the counterparty in the last 32 data bytes.
    const vaultIx = ixs[1];
    const [sessionPda] = deriveSessionPda(VAULT, COUNTERPARTY);
    expect(vaultIx.keys[3].pubkey.equals(sessionPda)).toBe(true);
    expect(vaultIx.keys[3].isWritable).toBe(true);
    expect(Buffer.from(vaultIx.data.subarray(vaultIx.data.length - 32)).equals(COUNTERPARTY.toBuffer())).toBe(true);
  });

  test('injected readPriorSpent receives the counterparty (per-session prior)', async () => {
    const readPriorSpent = vi.fn().mockResolvedValue(2_000_000n);
    await settleTab({
      ...baseParams,
      connection: {} as any,
      cumulativeAmount: 5_000_000n,
      assembleSignV2: async () => [],
      readPriorSpent,
    });
    const [, vaultArg, cpArg] = readPriorSpent.mock.calls[0];
    expect(vaultArg.equals(VAULT)).toBe(true);
    expect(cpArg.equals(COUNTERPARTY)).toBe(true);
  });

  test('default prior-spent read hits the session PDA and returns its spent odometer', async () => {
    const conn = connWith(rawSession({ spent: 2_000_000n }));
    let assemblerSawDelta: bigint | undefined;
    await settleTab({
      ...baseParams,
      connection: conn,
      cumulativeAmount: 5_000_000n,
      assembleSignV2: async (a: any) => {
        assemblerSawDelta = a.transfers[0].amount;
        return [];
      },
    });
    expect(assemblerSawDelta).toBe(3_000_000n);
    const [pda] = deriveSessionPda(VAULT, COUNTERPARTY);
    const [calledKey] = (conn.getAccountInfo as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(calledKey.equals(pda)).toBe(true);
  });

  test('default prior-spent read still works on an EXPIRED session (true odometer, deliberate)', async () => {
    // An expired-but-unswept session still carries the real spent odometer —
    // settleTab must read it, not refuse; the on-chain ix is the referee.
    const conn = connWith(rawSession({ spent: 2_000_000n, expiresAt: PAST }));
    let assemblerSawDelta: bigint | undefined;
    await settleTab({
      ...baseParams,
      connection: conn,
      cumulativeAmount: 5_000_000n,
      assembleSignV2: async (a: any) => {
        assemblerSawDelta = a.transfers[0].amount;
        return [];
      },
    });
    expect(assemblerSawDelta).toBe(3_000_000n);
  });

  test('default prior-spent read throws when the session PDA is absent', async () => {
    await expect(
      settleTab({
        ...baseParams,
        connection: connWith(null),
        cumulativeAmount: 5_000_000n,
        assembleSignV2: async () => [],
      }),
    ).rejects.toThrow(new RegExp(`no live session for counterparty ${COUNTERPARTY.toBase58()}`));
  });

  test('default prior-spent read throws on a cleared (version 0) session', async () => {
    await expect(
      settleTab({
        ...baseParams,
        connection: connWith(rawSession({ version: 0 })),
        cumulativeAmount: 5_000_000n,
        assembleSignV2: async () => [],
      }),
    ).rejects.toThrow(/no live session/);
  });

  test('rejects a non-monotonic settle (cumulative <= priorSpent)', async () => {
    await expect(
      settleTab({
        ...baseParams,
        connection: {} as any,
        cumulativeAmount: 2_000_000n,
        assembleSignV2: async () => [],
        readPriorSpent: async () => 2_000_000n,
      }),
    ).rejects.toThrow(/non-monotonic|cumulative/i);
  });
});
