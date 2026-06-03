import { describe, test, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { readVaultOnchain, readVaultFull } from '../src/reader/index.js';

/**
 * Build a synthetic vault account buffer that matches the v2 layout. The
 * shape mirrors what dexter-vault writes; if any offset drifts, the
 * reader/decoder fails — and that's the point.
 */
function makeVaultAccountData(opts: {
  hasWithdrawal: boolean;
  hasActiveSession: boolean;
}): Buffer {
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
    1 +    // active_session Option tag
    (opts.hasActiveSession ? 92 : 0);

  const data = Buffer.alloc(baseLen);
  // discriminator: any 8 bytes
  Buffer.from([0xDE, 0xAD, 0xBE, 0xEF, 0xCA, 0xFE, 0xBA, 0xBE]).copy(data, 0);
  data.writeUInt8(2, 8);  // version
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
  // active_session tag
  data.writeUInt8(opts.hasActiveSession ? 1 : 0, cursor); cursor += 1;
  if (opts.hasActiveSession) {
    Buffer.alloc(32, 0xFF).copy(data, cursor); cursor += 32;          // session_pubkey
    data.writeBigUInt64LE(1_000_000n, cursor); cursor += 8;            // max_amount
    data.writeBigInt64LE(1735689999n, cursor); cursor += 8;            // expires_at
    Buffer.alloc(32, 0x11).copy(data, cursor); cursor += 32;          // allowed_counterparty
    data.writeUInt32LE(42, cursor); cursor += 4;                       // nonce
    data.writeBigUInt64LE(50_000n, cursor); cursor += 8;               // spent
  }
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
    const data = makeVaultAccountData({ hasWithdrawal: false, hasActiveSession: false });
    const result = await readVaultOnchain(makeConn(data), PDA);
    expect(result).toMatchSnapshot();
  });

  test('with pending withdrawal → decoded', async () => {
    const data = makeVaultAccountData({ hasWithdrawal: true, hasActiveSession: false });
    const result = await readVaultOnchain(makeConn(data), PDA);
    expect(result).toMatchSnapshot();
  });
});

describe('readVaultFull (with active session)', () => {
  test('no active session', async () => {
    const data = makeVaultAccountData({ hasWithdrawal: false, hasActiveSession: false });
    const result = await readVaultFull(makeConn(data), PDA);
    expect(result).toMatchSnapshot();
  });

  test('with active session', async () => {
    const data = makeVaultAccountData({ hasWithdrawal: false, hasActiveSession: true });
    const result = await readVaultFull(makeConn(data), PDA);
    expect(result).toMatchSnapshot();
  });

  test('with both withdrawal and session (offsets shift +48)', async () => {
    const data = makeVaultAccountData({ hasWithdrawal: true, hasActiveSession: true });
    const result = await readVaultFull(makeConn(data), PDA);
    expect(result).toMatchSnapshot();
  });
});
