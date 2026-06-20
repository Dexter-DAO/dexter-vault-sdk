import { describe, it, expect } from 'vitest';
import { Connection, PublicKey } from '@solana/web3.js';
import { readVaultFull } from './accountReader.js';

// Vault layout (no pending_withdrawal): identity_claim @ 84, dexter_authority @ 116,
// live_session_count @ 148, outstanding_locked_amount @ 149, then the credit tail.
function buildVaultBuffer(opts: {
  swig: PublicKey; auth: PublicKey;
  outstanding: bigint; crystallized: bigint; settled: bigint;
  borrowed: bigint; standbyBacker: PublicKey | null; standbyCap: bigint;
  borrowRecoveryAt: bigint | null;
}): Buffer {
  const head = Buffer.alloc(149); // disc(8)..live_session_count(148) inclusive => first 149 bytes
  head.writeUInt8(6, 8);                      // version
  opts.swig.toBuffer().copy(head, 43);        // swig_address
  // pending_withdrawal tag @ 83 = 0 (absent) -> identity_claim @ 84, dexter_authority @ 116
  opts.auth.toBuffer().copy(head, 116);       // dexter_authority
  head.writeUInt8(0, 148);                    // live_session_count
  const tailParts: Buffer[] = [];
  const u64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };
  const i64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigInt64LE(v); return b; };
  tailParts.push(u64(opts.outstanding));      // @149
  tailParts.push(u64(opts.crystallized));
  tailParts.push(u64(opts.settled));
  tailParts.push(u64(opts.borrowed));
  if (opts.standbyBacker) {
    tailParts.push(Buffer.from([1]));
    tailParts.push(opts.standbyBacker.toBuffer());
  } else {
    tailParts.push(Buffer.from([0]));
  }
  tailParts.push(u64(opts.standbyCap));
  if (opts.borrowRecoveryAt !== null) {
    tailParts.push(Buffer.from([1]));
    tailParts.push(i64(opts.borrowRecoveryAt));
  } else {
    tailParts.push(Buffer.from([0]));
  }
  return Buffer.concat([head, ...tailParts]);
}

function mockConn(buf: Buffer): Connection {
  return { getAccountInfo: async () => ({ data: buf }) } as unknown as Connection;
}

const SWIG = new PublicKey('11111111111111111111111111111112');
const AUTH = new PublicKey('11111111111111111111111111111113');
const BACKER = new PublicKey('11111111111111111111111111111114');
const VAULT = new PublicKey('11111111111111111111111111111115');

describe('readVaultFull credit tail', () => {
  it('decodes borrowed/cap with standby_backer = Some and recovery armed', async () => {
    const buf = buildVaultBuffer({
      swig: SWIG, auth: AUTH, outstanding: 0n, crystallized: 0n, settled: 0n,
      borrowed: 500_000n, standbyBacker: BACKER, standbyCap: 1_000_000n,
      borrowRecoveryAt: 1_900_000_000n,
    });
    const v = await readVaultFull(mockConn(buf), VAULT);
    expect(v.borrowed).toBe('500000');
    expect(v.standbyBacker).toBe(BACKER.toBase58());
    expect(v.standbyCap).toBe('1000000');
    expect(v.borrowRecoveryAt).toBe(1_900_000_000);
  });

  it('decodes standby_backer = None with cap shifted by one byte', async () => {
    const buf = buildVaultBuffer({
      swig: SWIG, auth: AUTH, outstanding: 0n, crystallized: 0n, settled: 0n,
      borrowed: 0n, standbyBacker: null, standbyCap: 0n, borrowRecoveryAt: null,
    });
    const v = await readVaultFull(mockConn(buf), VAULT);
    expect(v.borrowed).toBe('0');
    expect(v.standbyBacker).toBeNull();
    expect(v.standbyCap).toBe('0');
    expect(v.borrowRecoveryAt).toBeNull();
  });
});
