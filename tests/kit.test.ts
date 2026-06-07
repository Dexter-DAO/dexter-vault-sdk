import { describe, test, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { kitInstructionsToWeb3, getRpc } from '../src/kit/index.js';

describe('kit bridge', () => {
  test('kitInstructionsToWeb3 converts a kit-v2 ix (boolean account shape) to web3.js', () => {
    const kitIx = {
      programAddress: 'Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc',
      accounts: [
        { address: 'So11111111111111111111111111111111111111112', signer: true, writable: true },
        { address: 'Sysvar1nstructions1111111111111111111111111', signer: false, writable: false },
      ],
      data: new Uint8Array([1, 2, 3]),
    };
    const [ix] = kitInstructionsToWeb3([kitIx]);
    expect(ix.programId.equals(new PublicKey('Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc'))).toBe(true);
    expect(ix.keys.length).toBe(2);
    expect(ix.keys[0].isSigner).toBe(true);
    expect(ix.keys[0].isWritable).toBe(true);
    expect(ix.keys[1].isSigner).toBe(false);
    expect(ix.keys[1].isWritable).toBe(false);
    expect(Array.from(ix.data)).toEqual([1, 2, 3]);
  });

  test('kitInstructionsToWeb3 decodes numeric role shape (role>=2 signer, odd writable)', () => {
    const kitIx = {
      programId: 'Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc',
      accounts: [{ publicKey: 'So11111111111111111111111111111111111111112', role: 3 }],
      data: [],
    };
    const [ix] = kitInstructionsToWeb3([kitIx]);
    expect(ix.keys[0].isSigner).toBe(true);
    expect(ix.keys[0].isWritable).toBe(true);
  });

  test('getRpc throws on a connection with no endpoint', () => {
    expect(() => getRpc({} as any)).toThrow(/cannot extract RPC endpoint/);
  });
});
