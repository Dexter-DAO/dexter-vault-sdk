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
