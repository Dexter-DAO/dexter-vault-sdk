import { describe, test, expect } from 'vitest';
import nacl from 'tweetnacl';
import { NodeEd25519Signer } from '../../src/signers/node/index.js';

describe('NodeEd25519Signer', () => {
  test('signs a message that tweetnacl can verify (32-byte seed)', async () => {
    const seed = new Uint8Array(32).fill(0x42);
    const signer = new NodeEd25519Signer(seed);
    const msg = new TextEncoder().encode('hello vault');
    const sig = await signer.sign(msg);
    expect(sig.length).toBe(64);
    expect(nacl.sign.detached.verify(msg, sig, signer.publicKey)).toBe(true);
  });

  test('accepts a 64-byte secret key', async () => {
    const seed = new Uint8Array(32).fill(0x11);
    const fullKey = nacl.sign.keyPair.fromSeed(seed).secretKey;
    const signer = new NodeEd25519Signer(fullKey);
    const msg = new Uint8Array([1, 2, 3]);
    const sig = await signer.sign(msg);
    expect(nacl.sign.detached.verify(msg, sig, signer.publicKey)).toBe(true);
  });

  test('rejects wrong-length secret key', () => {
    expect(() => new NodeEd25519Signer(new Uint8Array(16))).toThrow();
  });

  test('publicKey is stable', () => {
    const seed = new Uint8Array(32).fill(0x99);
    const a = new NodeEd25519Signer(seed);
    const b = new NodeEd25519Signer(seed);
    expect(Buffer.from(a.publicKey)).toEqual(Buffer.from(b.publicKey));
  });
});
