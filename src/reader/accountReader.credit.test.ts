import { describe, it, expect } from 'vitest';
import { Connection, PublicKey } from '@solana/web3.js';
import { readVaultFull } from './accountReader.js';

// V6 graph Vault layout (no pending_withdrawal): identity_claim @ 84,
// dexter_authority @ 116, live_session_count @ 148, then the fixed odometer tail:
//   outstanding_locked u64 @149 | total_crystallized u64 | total_settled u64 | node pk
// The V5 inline credit tail is gone — credit lives on the PrincipalNode graph now.
function buildVaultBuffer(opts: {
  swig: PublicKey; auth: PublicKey;
  outstanding: bigint; crystallized: bigint; settled: bigint;
  node: PublicKey;
}): Buffer {
  const head = Buffer.alloc(149); // disc(8)..live_session_count(148) inclusive
  head.writeUInt8(6, 8);                      // version
  opts.swig.toBuffer().copy(head, 43);        // swig_address
  // pending_withdrawal tag @ 83 = 0 (absent) -> identity_claim @ 84, dexter_authority @ 116
  opts.auth.toBuffer().copy(head, 116);       // dexter_authority
  head.writeUInt8(0, 148);                    // live_session_count
  const u64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };
  return Buffer.concat([
    head,
    u64(opts.outstanding),    // @149
    u64(opts.crystallized),
    u64(opts.settled),
    opts.node.toBuffer(),     // node pubkey
  ]);
}

function mockConn(buf: Buffer): Connection {
  return { getAccountInfo: async () => ({ data: buf }) } as unknown as Connection;
}

const SWIG = new PublicKey('11111111111111111111111111111112');
const AUTH = new PublicKey('11111111111111111111111111111113');
const NODE = new PublicKey('11111111111111111111111111111114');
const VAULT = new PublicKey('11111111111111111111111111111115');

describe('readVaultFull V6 graph tail', () => {
  it('decodes the odometers and the node anchor', async () => {
    const buf = buildVaultBuffer({
      swig: SWIG, auth: AUTH, outstanding: 7n, crystallized: 0n, settled: 0n, node: NODE,
    });
    const v = await readVaultFull(mockConn(buf), VAULT);
    expect(v.exists).toBe(true);
    expect(v.version).toBe(6);
    expect(v.swigAddress).toBe(SWIG.toBase58());
    expect(v.dexterAuthority).toBe(AUTH.toBase58());
    expect(v.outstandingLockedAmount).toBe('7');
    expect(v.node).toBe(NODE.toBase58());
  });

  it('returns node = null for a pre-graph vault too short to carry the field', async () => {
    const short = buildVaultBuffer({
      swig: SWIG, auth: AUTH, outstanding: 0n, crystallized: 0n, settled: 0n, node: NODE,
    }).subarray(0, 160); // truncate before the node pubkey
    const v = await readVaultFull(mockConn(short), VAULT);
    expect(v.exists).toBe(true);
    expect(v.node).toBeNull();
  });
});
