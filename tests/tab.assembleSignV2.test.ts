import { describe, test, expect } from 'vitest';
import type { AssembleSignV2, AssembleSignV2Args } from '../src/tab/assembleSignV2.js';
import { defaultAssembleSignV2 } from '../src/tab/assembleSignV2.js';
import { PublicKey, TransactionInstruction } from '@solana/web3.js';

describe('tab AssembleSignV2 contract', () => {
  test('an injected assembler is called with the composed args and its output is returned verbatim', async () => {
    const marker = new TransactionInstruction({
      programId: new PublicKey('Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc'),
      keys: [],
      data: Buffer.from([9]),
    });
    const fake: AssembleSignV2 = async (a: AssembleSignV2Args) => {
      expect(a.transfers.length).toBeGreaterThan(0);
      return [marker];
    };
    const out = await fake({
      connection: {} as any,
      swigAddress: new PublicKey('So11111111111111111111111111111111111111112'),
      feePayer: new PublicKey('So11111111111111111111111111111111111111112'),
      vaultIx: marker,
      transfers: [{ destinationAta: new PublicKey('So11111111111111111111111111111111111111112'), amount: 1n }],
    });
    expect(out).toEqual([marker]);
  });

  test('defaultAssembleSignV2 is a real exported function (module loads)', () => {
    expect(typeof defaultAssembleSignV2).toBe('function');
  });
});
