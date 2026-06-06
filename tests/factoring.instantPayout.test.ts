import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { buildInstantPayoutInstructions } from '../src/factoring/instantPayout.js';

const SWIG = new PublicKey('SysvarRent111111111111111111111111111111111');
const CLAIM = new PublicKey('11111111111111111111111111111111');
const VAULT = new PublicKey('SysvarC1ock11111111111111111111111111111111');
const FINANCIER = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const DEXTER_AUTH = new PublicKey('So11111111111111111111111111111111111111112');
const SELLER_ATA = new PublicKey('SysvarS1otHashes111111111111111111111111111');
const FINANCIER_ATA = new PublicKey('SysvarStakeHistory1111111111111111111111111');

describe('buildInstantPayoutInstructions', () => {
  it('emits [settleIx, ...signV2] and applies the split + preInstructions wiring', async () => {
    const recorded: Array<{ to: string; amount: bigint }> = [];
    let sawPreInstruction = false;
    const stubAssembleSignV2 = async (args: any) => {
      for (const t of args.transfers) recorded.push({ to: t.destinationAta.toBase58(), amount: t.amount });
      sawPreInstruction = !!args.settleIx && args.settleIx.keys.length === 6;
      return [{ programId: SWIG, keys: [], data: Buffer.alloc(0) }] as any;
    };

    const ixs = await buildInstantPayoutInstructions({
      connection: {} as any,
      swigAddress: SWIG, claimPda: CLAIM, vaultPda: VAULT, financier: FINANCIER,
      dexterAuthority: DEXTER_AUTH, claimAmount: 63_000_000n, financierSpread: 630_000n,
      sellerAta: SELLER_ATA, financierAta: FINANCIER_ATA, feePayer: DEXTER_AUTH,
      assembleSignV2: stubAssembleSignV2,
    });

    expect(ixs.length).toBe(2);
    expect(ixs[0].keys.length).toBe(6);
    expect(sawPreInstruction).toBe(true);
    expect(recorded).toContainEqual({ to: SELLER_ATA.toBase58(), amount: 62_370_000n });
    expect(recorded).toContainEqual({ to: FINANCIER_ATA.toBase58(), amount: 630_000n });
    expect(recorded.reduce((s, r) => s + r.amount, 0n)).toBe(63_000_000n);
  });

  it('omits the financier transfer when spread is 0', async () => {
    const recorded: Array<{ to: string; amount: bigint }> = [];
    const stub = async (args: any) => {
      for (const t of args.transfers) recorded.push({ to: t.destinationAta.toBase58(), amount: t.amount });
      return [] as any;
    };
    await buildInstantPayoutInstructions({
      connection: {} as any, swigAddress: SWIG, claimPda: CLAIM, vaultPda: VAULT, financier: FINANCIER,
      dexterAuthority: DEXTER_AUTH, claimAmount: 1_000_000n, financierSpread: 0n,
      sellerAta: SELLER_ATA, financierAta: FINANCIER_ATA, feePayer: DEXTER_AUTH, assembleSignV2: stub,
    });
    expect(recorded).toEqual([{ to: SELLER_ATA.toBase58(), amount: 1_000_000n }]);
  });
});
