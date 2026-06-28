import { describe, test, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { readVaultOnchain, readVaultFull } from '../src/reader/index.js';

/**
 * Build a synthetic vault account buffer over the shared prefix layout
 * (V2+ through V6 — fields before the session region never moved). The
 * shape mirrors what dexter-vault writes; if any offset drifts, the
 * reader/decoder fails — and that's the point.
 */
function makeVaultAccountData(opts: { hasWithdrawal: boolean }): Buffer {
  const baseLen =
    8 +    // discriminator
    1 +    // version
    1 +    // bump
    33 +   // passkey_pubkey
    32 +   // swig_address
    4 +    // cooling_off_seconds
    4 +    // pending_voucher_count
    1 +    // pending_withdrawal Option tag
    (opts.hasWithdrawal ? 48 : 0) +
    32 +   // identity_claim
    32 +   // dexter_authority
    1;     // V6 live_session_count (was V5's active_session Option tag)

  const data = Buffer.alloc(baseLen);
  // discriminator: any 8 bytes
  Buffer.from([0xDE, 0xAD, 0xBE, 0xEF, 0xCA, 0xFE, 0xBA, 0xBE]).copy(data, 0);
  data.writeUInt8(6, 8);  // version (slim reader is version-agnostic; nothing here asserts it)
  data.writeUInt8(255, 9);  // bump
  // passkey_pubkey: 33 bytes of 0xAA
  Buffer.alloc(33, 0xAA).copy(data, 10);
  // swig_address: 32 bytes of 0xBB
  Buffer.alloc(32, 0xBB).copy(data, 43);
  // cooling_off_seconds: 0
  data.writeUInt32LE(0, 75);
  // pending_voucher_count: 7
  data.writeUInt32LE(7, 79);
  // pending_withdrawal
  data.writeUInt8(opts.hasWithdrawal ? 1 : 0, 83);
  let cursor = 84;
  if (opts.hasWithdrawal) {
    data.writeBigUInt64LE(100_000n, cursor); cursor += 8;
    Buffer.alloc(32, 0xCC).copy(data, cursor); cursor += 32;
    data.writeBigInt64LE(1735689600n, cursor); cursor += 8;
  }
  // identity_claim
  Buffer.alloc(32, 0xDD).copy(data, cursor); cursor += 32;
  // dexter_authority
  Buffer.alloc(32, 0xEE).copy(data, cursor); cursor += 32;
  // live_session_count: 0
  data.writeUInt8(0, cursor); cursor += 1;
  return data;
}

/** Stub Connection that satisfies the readers' interface. */
function makeConn(data: Buffer | null) {
  return {
    getAccountInfo: async () => (data ? { data, executable: false, lamports: 0, owner: new PublicKey('Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc'), rentEpoch: 0 } : null),
  } as any;
}

const PDA = new PublicKey('Sysvar1nstructions1111111111111111111111111');

describe('readVaultOnchain (slim)', () => {
  test('account missing → exists=false', async () => {
    const result = await readVaultOnchain(makeConn(null), PDA);
    expect(result).toEqual({ exists: false, pendingVoucherCount: 0, pendingWithdrawal: null });
  });

  test('no pending withdrawal → pendingWithdrawal=null', async () => {
    const data = makeVaultAccountData({ hasWithdrawal: false });
    const result = await readVaultOnchain(makeConn(data), PDA);
    expect(result).toMatchSnapshot();
  });

  test('with pending withdrawal → decoded', async () => {
    const data = makeVaultAccountData({ hasWithdrawal: true });
    const result = await readVaultOnchain(makeConn(data), PDA);
    expect(result).toMatchSnapshot();
  });
});

/**
 * V6 vault fixture. The byte that was V5's active_session Option tag is now
 * live_session_count: u8 — the old reader mis-decoded that byte as an Option
 * tag and "found" a session made of locked-claim odometer bytes. These cases
 * pin the V6 read.
 *
 * Real V6 vaults carry more bytes after live_session_count (odometers/credit
 * fields) — the reader doesn't decode those. `trailing` proves the reader
 * tolerates them; the default (ending AT liveCount) also exercises the
 * length guard.
 */
function v6VaultBytes(opts: {
  liveSessionCount: number;
  withdrawal?: boolean;
  trailing?: number;
  outstandingLocked?: bigint;
}): { data: Buffer; swig: PublicKey; authority: PublicKey } {
  const withdrawalBody = opts.withdrawal ? 48 : 0;
  // disc(8) ver(1) bump(1) passkey(33) swig(32) cooling(4) pvc(4) wtag(1) [wbody] identity(32) authority(32) liveCount(1) outstandingLocked(8)
  const len = 8 + 1 + 1 + 33 + 32 + 4 + 4 + 1 + withdrawalBody + 32 + 32 + 1 + 8 + (opts.trailing ?? 0);
  const data = Buffer.alloc(len);
  data.writeUInt8(6, 8); // version = 6
  const swig = PublicKey.unique();
  swig.toBuffer().copy(data, 43);
  data.writeUInt32LE(2, 79); // pending_voucher_count
  data.writeUInt8(opts.withdrawal ? 1 : 0, 83);
  if (opts.withdrawal) {
    data.writeBigUInt64LE(100_000n, 84);
    Buffer.alloc(32, 0xCC).copy(data, 92);
    data.writeBigInt64LE(1735689600n, 124);
  }
  const afterWithdrawal = 84 + withdrawalBody;
  const authority = PublicKey.unique();
  authority.toBuffer().copy(data, afterWithdrawal + 32); // dexter_authority
  data.writeUInt8(opts.liveSessionCount, afterWithdrawal + 64); // live_session_count
  data.writeBigUInt64LE(opts.outstandingLocked ?? 0n, afterWithdrawal + 65); // outstanding_locked_amount
  return { data, swig, authority };
}

describe('readVaultFull (V6: live_session_count, NO activeSession)', () => {
  test('liveSessionCount = 3 decoded; exact key set (no activeSession)', async () => {
    const { data, swig, authority } = v6VaultBytes({ liveSessionCount: 3, outstandingLocked: 250_000n });
    const result = await readVaultFull(makeConn(data), PDA);
    expect(result).toEqual({
      exists: true,
      version: 6,
      swigAddress: swig.toBase58(),
      dexterAuthority: authority.toBase58(),
      pendingVoucherCount: 2,
      liveSessionCount: 3,
      outstandingLockedAmount: '250000',
      node: null,
    });
    expect('activeSession' in result).toBe(false);
  });

  test('liveSessionCount = 0 decoded as 0', async () => {
    const { data } = v6VaultBytes({ liveSessionCount: 0 });
    const result = await readVaultFull(makeConn(data), PDA);
    expect(result.liveSessionCount).toBe(0);
  });

  test('withdrawal present → liveSessionCount read at the +48-shifted offset', async () => {
    const { data, swig, authority } = v6VaultBytes({ liveSessionCount: 5, withdrawal: true, outstandingLocked: 999n });
    const result = await readVaultFull(makeConn(data), PDA);
    expect(result).toEqual({
      exists: true,
      version: 6,
      swigAddress: swig.toBase58(),
      dexterAuthority: authority.toBase58(),
      pendingVoucherCount: 2,
      liveSessionCount: 5,
      outstandingLockedAmount: '999',
      node: null,
    });
  });

  test('trailing bytes after live_session_count (real V6 odometer region) → same result', async () => {
    const { data } = v6VaultBytes({ liveSessionCount: 3, trailing: 50 });
    const result = await readVaultFull(makeConn(data), PDA);
    expect(result.liveSessionCount).toBe(3);
    expect(result.version).toBe(6);
    expect('activeSession' in result).toBe(false);
  });

  test('account absent → EMPTY_FULL with liveSessionCount 0', async () => {
    const result = await readVaultFull(makeConn(null), PDA);
    expect(result).toEqual({
      exists: false,
      version: 0,
      swigAddress: null,
      dexterAuthority: null,
      pendingVoucherCount: 0,
      liveSessionCount: 0,
      outstandingLockedAmount: '0',
      node: null,
    });
  });
});
