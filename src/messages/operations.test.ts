import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { buildOpenStandbyMessage, buildAttachNodeMessage } from './operations.js';

describe('buildOpenStandbyMessage', () => {
  // Deterministic, known pubkeys (byte 0 = N for visual byte-slicing).
  const vaultPda = new PublicKey(new Uint8Array(32).fill(1));
  const financierSwig = new PublicKey(new Uint8Array(32).fill(2));

  it('matches the open_standby op-message byte layout (84 bytes)', () => {
    const cap = 100000n;
    const msg = buildOpenStandbyMessage(vaultPda, financierSwig, cap);

    // total length
    expect(msg.length).toBe(84);

    // bytes 0..11 = "open_standby" (UTF-8)
    const tag = new TextDecoder().decode(msg.slice(0, 12));
    expect(tag).toBe('open_standby');

    // bytes 12..43 = vaultPda
    expect([...msg.slice(12, 44)]).toEqual([...vaultPda.toBytes()]);

    // bytes 44..75 = financierSwig
    expect([...msg.slice(44, 76)]).toEqual([...financierSwig.toBytes()]);

    // bytes 76..83 = cap u64 LE. 100000 = 0x0186A0 -> LE: A0 86 01 00 00 00 00 00
    expect([...msg.slice(76, 84)]).toEqual([0xa0, 0x86, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00]);

    // and decoding it back as a LE u64 yields the cap
    expect(new DataView(msg.buffer, msg.byteOffset, msg.byteLength).getBigUint64(76, true)).toBe(cap);
  });

  it('round-trips an arbitrary cap as little-endian u64', () => {
    const cap = 0x0102030405060708n;
    const msg = buildOpenStandbyMessage(vaultPda, financierSwig, cap);
    expect([...msg.slice(76, 84)]).toEqual([0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01]);
  });
});

describe('buildAttachNodeMessage', () => {
  // Deterministic, known pubkeys (byte fill = N for visual byte-slicing).
  const vaultPda = new PublicKey(new Uint8Array(32).fill(3));
  const node = new PublicKey(new Uint8Array(32).fill(4));

  it('matches the attach_node op-message byte layout (75 bytes)', () => {
    const msg = buildAttachNodeMessage(vaultPda, node);

    // total length: "attach_node"(11) + vault(32) + node(32)
    expect(msg.length).toBe(75);

    // bytes 0..10 = "attach_node" (UTF-8, 11 bytes)
    const tag = new TextDecoder().decode(msg.slice(0, 11));
    expect(tag).toBe('attach_node');

    // bytes 11..42 = vaultPda
    expect([...msg.slice(11, 43)]).toEqual([...vaultPda.toBytes()]);

    // bytes 43..74 = node
    expect([...msg.slice(43, 75)]).toEqual([...node.toBytes()]);
  });

  it('binds vault and node positionally (swapping changes the message)', () => {
    const a = buildAttachNodeMessage(vaultPda, node);
    const b = buildAttachNodeMessage(node, vaultPda);
    expect([...a]).not.toEqual([...b]);
  });
});

// ── Byte-parity with the absorbed dexter-fe operationMessages.ts (2026-07-18) ──
import { describe as describe2, test as test2, expect as expect2 } from 'vitest';
import {
  buildRequestWithdrawalMessage,
  buildFinalizeWithdrawalMessage,
  buildForceReleaseMessage,
  buildClaimVaultChallenge,
  buildProvePasskeyMessage,
} from './operations.js';
import { PublicKey as PK2 } from '@solana/web3.js';
import { createHash as ch2 } from 'node:crypto';

const DEST = new PK2('Root1qgf4hpvihXWivsvHNAhDdPMhwgVkwyGJiz38iL');
const SWIG = new PK2('qvz9QPwSHHRhwwUhpxdp5w3pbLiSPfgSz7nGbRrXYDQ');

describe2('absorbed op messages — byte parity with the retired FE implementation', () => {
  test2('request_withdrawal layout: tag(18)+amount+dest+signedAt = 66 bytes', () => {
    const m = Buffer.from(buildRequestWithdrawalMessage(1_500_000n, DEST, 1789000000n));
    expect2(m.length).toBe(66);
    expect2(m.subarray(0, 18).toString('utf8')).toBe('request_withdrawal');
    expect2(m.readBigUInt64LE(18)).toBe(1_500_000n);
    expect2(new PK2(m.subarray(26, 58)).equals(DEST)).toBe(true);
    expect2(m.readBigInt64LE(58)).toBe(1789000000n);
  });

  test2('finalize_withdrawal layout: tag(19)+amount+dest = 59 bytes', () => {
    const m = Buffer.from(buildFinalizeWithdrawalMessage(999_798n, DEST));
    expect2(m.length).toBe(59);
    expect2(m.subarray(0, 19).toString('utf8')).toBe('finalize_withdrawal');
    expect2(m.readBigUInt64LE(19)).toBe(999_798n);
    expect2(new PK2(m.subarray(27, 59)).equals(DEST)).toBe(true);
  });

  test2('force_release = tag(13)+swig(32)', () => {
    const m = Buffer.from(buildForceReleaseMessage(SWIG));
    expect2(m.length).toBe(45);
    expect2(m.subarray(0, 13).toString('utf8')).toBe('force_release');
    expect2(new PK2(m.subarray(13)).equals(SWIG)).toBe(true);
  });

  test2('claim challenge == sha256("claim_vault" || vault)', async () => {
    const got = Buffer.from(await buildClaimVaultChallenge(DEST));
    const want = ch2('sha256')
      .update(Buffer.concat([Buffer.from('claim_vault'), DEST.toBuffer()]))
      .digest();
    expect2(got.equals(want)).toBe(true);
  });

  test2('prove_passkey = "siwx_login" + 32-byte challenge, rejects wrong length', () => {
    const c = Buffer.alloc(32, 9);
    const m = Buffer.from(buildProvePasskeyMessage(c));
    expect2(m.subarray(0, 10).toString('utf8')).toBe('siwx_login');
    expect2(m.subarray(10).equals(c)).toBe(true);
    expect2(() => buildProvePasskeyMessage(Buffer.alloc(31))).toThrow();
  });
});
