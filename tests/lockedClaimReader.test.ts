import { describe, test, expect, vi } from 'vitest';
import { Connection, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { readVaultFull } from '../src/reader/index.js';
import {
  decodeLockedClaim,
  fetchVaultLockedClaims,
} from '../src/reader/index.js';
import type { LockedClaimStatus } from '../src/reader/index.js';
import {
  LOCKED_CLAIM_DISCRIMINATOR,
  LOCKED_CLAIM_DISCRIMINATOR_B58,
  LOCKED_CLAIM_VAULT_OFFSET,
} from '../src/constants/index.js';

const PDA = new PublicKey('Sysvar1nstructions1111111111111111111111111');

/** Stub Connection for the account read used by readVaultFull. */
function makeConn(data: Buffer | null) {
  return {
    getAccountInfo: async () =>
      data
        ? {
            data,
            executable: false,
            lamports: 0,
            owner: new PublicKey('Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc'),
            rentEpoch: 0,
          }
        : null,
  } as unknown as Connection;
}

/**
 * V6 vault fixture carrying `outstanding_locked_amount: u64` immediately after
 * `live_session_count: u8` (matches programs/dexter-vault/src/state.rs::Vault).
 */
function v6VaultBytes(opts: {
  liveSessionCount: number;
  outstandingLocked: bigint;
  withdrawal?: boolean;
}): { data: Buffer; swig: PublicKey; authority: PublicKey } {
  const withdrawalBody = opts.withdrawal ? 48 : 0;
  // disc(8) ver(1) bump(1) passkey(33) swig(32) cooling(4) pvc(4) wtag(1) [wbody] identity(32) authority(32) liveCount(1) outstandingLocked(8)
  const len = 8 + 1 + 1 + 33 + 32 + 4 + 4 + 1 + withdrawalBody + 32 + 32 + 1 + 8;
  const data = Buffer.alloc(len);
  data.writeUInt8(6, 8); // version = 6
  const swig = PublicKey.unique();
  swig.toBuffer().copy(data, 43);
  data.writeUInt32LE(2, 79); // pending_voucher_count
  data.writeUInt8(opts.withdrawal ? 1 : 0, 83);
  if (opts.withdrawal) {
    data.writeBigUInt64LE(100_000n, 84);
    Buffer.alloc(32, 0xcc).copy(data, 92);
    data.writeBigInt64LE(1735689600n, 124);
  }
  const afterWithdrawal = 84 + withdrawalBody;
  const authority = PublicKey.unique();
  authority.toBuffer().copy(data, afterWithdrawal + 32); // dexter_authority
  data.writeUInt8(opts.liveSessionCount, afterWithdrawal + 64); // live_session_count
  data.writeBigUInt64LE(opts.outstandingLocked, afterWithdrawal + 65); // outstanding_locked_amount
  return { data, swig, authority };
}

describe('readVaultFull surfaces outstandingLockedAmount', () => {
  test('decodes the u64 immediately after live_session_count as a decimal string', async () => {
    const { data } = v6VaultBytes({
      liveSessionCount: 3,
      outstandingLocked: 123_456_789n,
    });
    const result = await readVaultFull(makeConn(data), PDA);
    expect(result.outstandingLockedAmount).toBe('123456789');
  });

  test('handles a value beyond Number.MAX_SAFE_INTEGER without precision loss', async () => {
    const big = 18_446_744_073_709_551_000n; // near u64 max
    const { data } = v6VaultBytes({ liveSessionCount: 0, outstandingLocked: big });
    const result = await readVaultFull(makeConn(data), PDA);
    expect(result.outstandingLockedAmount).toBe(big.toString());
  });

  test('withdrawal-shifted offset still finds outstanding_locked_amount', async () => {
    const { data } = v6VaultBytes({
      liveSessionCount: 5,
      outstandingLocked: 42n,
      withdrawal: true,
    });
    const result = await readVaultFull(makeConn(data), PDA);
    expect(result.outstandingLockedAmount).toBe('42');
    expect(result.liveSessionCount).toBe(5);
  });

  test('account absent → outstandingLockedAmount "0"', async () => {
    const result = await readVaultFull(makeConn(null), PDA);
    expect(result.outstandingLockedAmount).toBe('0');
  });

  test('account too short to hold outstanding_locked_amount → "0"', async () => {
    // Truncate one byte before the u64 starts.
    const { data } = v6VaultBytes({ liveSessionCount: 1, outstandingLocked: 9n });
    const truncated = data.subarray(0, data.length - 8); // drop the u64
    const result = await readVaultFull(makeConn(truncated), PDA);
    expect(result.outstandingLockedAmount).toBe('0');
  });
});

/**
 * Build a LockedClaim account buffer with a MOVING CURSOR so we exercise the
 * Option<i64> variable layout (the high-risk decode path).
 */
function rawLockedClaim(opts: {
  vault: PublicKey;
  sessionPubkeyAtLock?: Uint8Array;
  voucherHash?: Uint8Array;
  amount?: bigint;
  createdAt?: bigint;
  maturityAt?: bigint | null;
  holderRecoveryAt?: bigint | null;
  currentHolder: PublicKey;
  status: number; // 0=Pending,1=Settled,2=Abandoned
  settledAt?: bigint | null;
  recoveredAt?: bigint | null;
  version?: number;
  bump?: number;
}): Buffer {
  const chunks: Buffer[] = [];
  const opt = (v: bigint | null | undefined): Buffer => {
    if (v === null || v === undefined) return Buffer.from([0x00]);
    const b = Buffer.alloc(9);
    b.writeUInt8(0x01, 0);
    b.writeBigInt64LE(v, 1);
    return b;
  };

  chunks.push(Buffer.from(LOCKED_CLAIM_DISCRIMINATOR)); // 8
  const head = Buffer.alloc(2 + 32 + 32 + 32 + 8 + 8);
  let c = 0;
  head.writeUInt8(opts.version ?? 1, c); c += 1;
  head.writeUInt8(opts.bump ?? 254, c); c += 1;
  opts.vault.toBuffer().copy(head, c); c += 32;
  Buffer.from(opts.sessionPubkeyAtLock ?? Buffer.alloc(32, 0x11)).copy(head, c); c += 32;
  Buffer.from(opts.voucherHash ?? Buffer.alloc(32, 0x22)).copy(head, c); c += 32;
  head.writeBigUInt64LE(opts.amount ?? 1_000_000n, c); c += 8;
  head.writeBigInt64LE(opts.createdAt ?? 1700000000n, c); c += 8;
  chunks.push(head);

  chunks.push(opt(opts.maturityAt));
  chunks.push(opt(opts.holderRecoveryAt));
  chunks.push(opts.currentHolder.toBuffer());
  chunks.push(Buffer.from([opts.status]));
  chunks.push(opt(opts.settledAt));
  chunks.push(opt(opts.recoveredAt));

  return Buffer.concat(chunks);
}

describe('decodeLockedClaim (moving-cursor Option layout)', () => {
  test('maturity_at = None: trailing fields decode correctly', () => {
    const vault = PublicKey.unique();
    const holder = PublicKey.unique();
    const addr = PublicKey.unique();
    const data = rawLockedClaim({
      vault,
      currentHolder: holder,
      amount: 5_000_000n,
      createdAt: 1700000001n,
      maturityAt: null,
      holderRecoveryAt: null,
      status: 0,
      settledAt: null,
      recoveredAt: null,
    });
    const out = decodeLockedClaim(addr.toBase58(), data);
    expect(out.address).toBe(addr.toBase58());
    expect(out.vault).toBe(vault.toBase58());
    expect(out.amount).toBe('5000000');
    expect(out.createdAt).toBe(1700000001);
    expect(out.maturityAt).toBeNull();
    expect(out.holderRecoveryAt).toBeNull();
    expect(out.currentHolder).toBe(holder.toBase58());
    expect(out.status).toBe<LockedClaimStatus>('Pending');
    expect(out.settledAt).toBeNull();
    expect(out.recoveredAt).toBeNull();
  });

  test('maturity_at = Some: cursor advances 9 and trailing fields still align', () => {
    const vault = PublicKey.unique();
    const holder = PublicKey.unique();
    const addr = PublicKey.unique();
    const data = rawLockedClaim({
      vault,
      currentHolder: holder,
      amount: 7_777n,
      createdAt: 1700000002n,
      maturityAt: 1700009999n,
      holderRecoveryAt: 1700019999n,
      status: 1, // Settled
      settledAt: 1700005555n,
      recoveredAt: null,
    });
    const out = decodeLockedClaim(addr.toBase58(), data);
    expect(out.vault).toBe(vault.toBase58());
    expect(out.maturityAt).toBe(1700009999);
    expect(out.holderRecoveryAt).toBe(1700019999);
    expect(out.currentHolder).toBe(holder.toBase58());
    expect(out.status).toBe('Settled');
    expect(out.settledAt).toBe(1700005555);
    expect(out.recoveredAt).toBeNull();
  });

  test('status byte 2 → Abandoned, with recoveredAt set', () => {
    const vault = PublicKey.unique();
    const holder = PublicKey.unique();
    const data = rawLockedClaim({
      vault,
      currentHolder: holder,
      maturityAt: 123n,
      holderRecoveryAt: null,
      status: 2,
      settledAt: null,
      recoveredAt: 999n,
    });
    const out = decodeLockedClaim(PublicKey.unique().toBase58(), data);
    expect(out.status).toBe('Abandoned');
    expect(out.recoveredAt).toBe(999);
  });

  test('throws a clean addressed "truncated" error for a short fixed prefix (not a raw RangeError)', () => {
    const addr = PublicKey.unique().toBase58();
    // Valid discriminator but only ~100 bytes — short of the 122-byte fixed prefix.
    const data = Buffer.alloc(100);
    Buffer.from(LOCKED_CLAIM_DISCRIMINATOR).copy(data, 0);
    let caught: unknown;
    try {
      decodeLockedClaim(addr, data);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).toBe('Error'); // NOT a RangeError [ERR_OUT_OF_RANGE]
    expect((caught as Error).message).toContain(addr);
    expect((caught as Error).message).toContain('truncated');
  });

  test('throws a clean addressed "truncated" error when cut mid-Option / before current_holder', () => {
    const vault = PublicKey.unique();
    const addr = PublicKey.unique().toBase58();
    const full = rawLockedClaim({
      vault,
      currentHolder: PublicKey.unique(),
      maturityAt: 5n,
      holderRecoveryAt: null,
      status: 0,
    });
    // Keep the full 122-byte fixed prefix + a couple Option bytes, then cut
    // before current_holder lands.
    const data = full.subarray(0, 125);
    let caught: unknown;
    try {
      decodeLockedClaim(addr, data);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).toBe('Error'); // NOT a RangeError
    expect((caught as Error).message).toContain(addr);
    expect((caught as Error).message).toContain('truncated');
  });

  test('rejects a buffer whose discriminator is not a LockedClaim', () => {
    const data = rawLockedClaim({
      vault: PublicKey.unique(),
      currentHolder: PublicKey.unique(),
      status: 0,
    });
    data[0] = 0x00; // corrupt discriminator
    expect(() => decodeLockedClaim('addr', data)).toThrow(/discriminator/);
  });
});

describe('fetchVaultLockedClaims', () => {
  test('queries gPA with disc@0 + vault@10 filters, NO dataSize, and decodes all', async () => {
    const vault = PublicKey.unique();
    const accounts = [
      {
        pubkey: PublicKey.unique(),
        account: {
          data: rawLockedClaim({ vault, currentHolder: PublicKey.unique(), status: 0, maturityAt: null }),
        },
      },
      {
        pubkey: PublicKey.unique(),
        account: {
          data: rawLockedClaim({ vault, currentHolder: PublicKey.unique(), status: 1, maturityAt: 5n, settledAt: 6n }),
        },
      },
    ];
    const conn = {
      getProgramAccounts: vi.fn().mockResolvedValue(accounts),
    } as unknown as Connection;

    const out = await fetchVaultLockedClaims(conn, vault);
    expect(out).toHaveLength(2);
    expect(out[0].vault).toBe(vault.toBase58());
    expect(out[1].status).toBe('Settled');

    const [programId, cfg] = (conn.getProgramAccounts as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(programId.toBase58()).toBe('Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc');
    expect(cfg.commitment).toBe('confirmed');
    // CRITICAL: variable-length account → NO dataSize filter.
    expect(cfg.filters.some((f: { dataSize?: number }) => 'dataSize' in f)).toBe(false);
    expect(cfg.filters).toEqual([
      { memcmp: { offset: 0, bytes: LOCKED_CLAIM_DISCRIMINATOR_B58 } },
      { memcmp: { offset: LOCKED_CLAIM_VAULT_OFFSET, bytes: vault.toBase58() } },
    ]);
  });

  test('status filter keeps only matching claims', async () => {
    const vault = PublicKey.unique();
    const accounts = [
      { pubkey: PublicKey.unique(), account: { data: rawLockedClaim({ vault, currentHolder: PublicKey.unique(), status: 0, maturityAt: null }) } },
      { pubkey: PublicKey.unique(), account: { data: rawLockedClaim({ vault, currentHolder: PublicKey.unique(), status: 1, maturityAt: 5n, settledAt: 6n }) } },
      { pubkey: PublicKey.unique(), account: { data: rawLockedClaim({ vault, currentHolder: PublicKey.unique(), status: 0, maturityAt: null }) } },
    ];
    const conn = {
      getProgramAccounts: vi.fn().mockResolvedValue(accounts),
    } as unknown as Connection;

    const pending = await fetchVaultLockedClaims(conn, vault, { status: 'Pending' });
    expect(pending).toHaveLength(2);
    expect(pending.every((c) => c.status === 'Pending')).toBe(true);

    const settled = await fetchVaultLockedClaims(conn, vault, { status: 'Settled' });
    expect(settled).toHaveLength(1);
    expect(settled[0].status).toBe('Settled');
  });

  test('LOCKED_CLAIM_DISCRIMINATOR_B58 equals bs58(LOCKED_CLAIM_DISCRIMINATOR)', () => {
    expect(LOCKED_CLAIM_DISCRIMINATOR_B58).toBe(bs58.encode(LOCKED_CLAIM_DISCRIMINATOR));
    expect(LOCKED_CLAIM_VAULT_OFFSET).toBe(10);
  });

  test('returns [] when gPA finds nothing', async () => {
    const conn = {
      getProgramAccounts: vi.fn().mockResolvedValue([]),
    } as unknown as Connection;
    const out = await fetchVaultLockedClaims(conn, PublicKey.unique());
    expect(out).toEqual([]);
  });
});
