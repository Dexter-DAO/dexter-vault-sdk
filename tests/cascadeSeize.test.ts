/**
 * Unit test for GraphClient.cascadeSeize allocation math (Task 13).
 *
 * Exercises ONLY the cascade loop — walk ancestors nearest→root, clamp each leg
 * to min(remaining, maxCover), skip null/zero-cover ancestors, stop when
 * remaining===0 or the chain is exhausted, and return remainingShortfall. The
 * chain read (walkAncestors) and shortfall read (readPrincipalNode) are mocked,
 * so there is NO network and NO validator; resolveAncestor is a plain callback
 * and assembleSignV2 is stubbed to emit no instructions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PublicKey } from '@solana/web3.js';

// Mock the reader module BEFORE importing GraphClient (vi.mock is hoisted).
vi.mock('../src/reader/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/reader/index.js')>();
  return { ...actual, readPrincipalNode: vi.fn(), walkAncestors: vi.fn() };
});

import { GraphClient } from '../src/tab/credit.js';
import { DISCRIMINATORS } from '../src/constants/index.js';
import { readPrincipalNode, walkAncestors } from '../src/reader/index.js';

const readPrincipalNodeMock = vi.mocked(readPrincipalNode);
const walkAncestorsMock = vi.mocked(walkAncestors);

const LEAF = new PublicKey('SysvarS1otHashes111111111111111111111111111');
const ANC1 = new PublicKey('SysvarEpochSchedu1e111111111111111111111111');
const ANC2 = new PublicKey('SysvarRecentB1ockHashes11111111111111111111');
const ANC3 = new PublicKey('SysvarStakeHistory1111111111111111111111111');
const DEXTER = new PublicKey('So11111111111111111111111111111111111111112');
const FEE_PAYER = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const SWIG = new PublicKey('SysvarRent111111111111111111111111111111111');
const ATA = new PublicKey('SysvarC1ock11111111111111111111111111111111');

// Kit-faithful stub: @swig-wallet/kit's getSignInstructions returns its
// preInstructions (the vault ix) IN the ordered output, so the stub echoes
// vaultIx. cascadeSeize must NOT re-prepend it (double-include reverts on-chain).
const stubAssemble = async (a: any) => [a.vaultIx];

function fundingOf(maxCover: bigint) {
  return { ancestorSwig: SWIG, financierAta: ATA, maxCover, assembleSignV2: stubAssemble };
}

/** Build a GraphClient whose leaf carries `shortfall` and whose chain is `path`. */
function client(shortfall: bigint, path: PublicKey[]) {
  readPrincipalNodeMock.mockResolvedValue({ shortfall: shortfall.toString() } as any);
  // walkAncestors returns the FULL path leaf→root inclusive; cascade slices off the leaf.
  walkAncestorsMock.mockResolvedValue([LEAF, ...path]);
  return new GraphClient({} as any);
}

describe('GraphClient.cascadeSeize allocation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('clamps per leg [partial, partial, rest] and fully covers (remaining 0)', async () => {
    const gc = client(100n, [ANC1, ANC2, ANC3]);
    const resolveAncestor = vi.fn(async (n: PublicKey) => {
      if (n.equals(ANC1)) return fundingOf(40n); // min(100,40)=40, rem 60
      if (n.equals(ANC2)) return fundingOf(30n); // min(60,30)=30, rem 30
      if (n.equals(ANC3)) return fundingOf(1000n); // min(30,1000)=30, rem 0
      return null;
    });
    const { steps, remainingShortfall } = await gc.cascadeSeize({
      defaultedNode: LEAF,
      dexterAuthority: DEXTER,
      feePayer: FEE_PAYER,
      resolveAncestor,
    });
    expect(steps.map((s) => s.amount)).toEqual([40n, 30n, 30n]);
    expect(steps.map((s) => s.ancestorNode)).toEqual([ANC1, ANC2, ANC3]);
    expect(remainingShortfall).toBe(0n);
    // REGRESSION PIN: each leg carries seize_ancestor EXACTLY once (double-include reverts).
    for (const s of steps) {
      const n = s.instructions.filter(
        (ix) => ix.data.length >= 8 && DISCRIMINATORS.seize_ancestor.every((b, i) => ix.data[i] === b),
      ).length;
      expect(n).toBe(1);
    }
  });

  it('stops early once remaining hits 0 (does not resolve later ancestors)', async () => {
    const gc = client(40n, [ANC1, ANC2]);
    const resolveAncestor = vi.fn(async (n: PublicKey) => {
      if (n.equals(ANC1)) return fundingOf(40n); // covers all → break before ANC2
      return fundingOf(1000n);
    });
    const { steps, remainingShortfall } = await gc.cascadeSeize({
      defaultedNode: LEAF,
      dexterAuthority: DEXTER,
      feePayer: FEE_PAYER,
      resolveAncestor,
    });
    expect(steps.map((s) => s.amount)).toEqual([40n]);
    expect(remainingShortfall).toBe(0n);
    expect(resolveAncestor).toHaveBeenCalledTimes(1);
    expect(resolveAncestor).not.toHaveBeenCalledWith(ANC2);
  });

  it('skips null (dry swig) and zero-cover ancestors', async () => {
    const gc = client(50n, [ANC1, ANC2, ANC3]);
    const resolveAncestor = vi.fn(async (n: PublicKey) => {
      if (n.equals(ANC1)) return null; // dry swig → skip
      if (n.equals(ANC2)) return fundingOf(0n); // zero cover → skip
      if (n.equals(ANC3)) return fundingOf(1000n); // covers remainder
      return null;
    });
    const { steps, remainingShortfall } = await gc.cascadeSeize({
      defaultedNode: LEAF,
      dexterAuthority: DEXTER,
      feePayer: FEE_PAYER,
      resolveAncestor,
    });
    expect(steps.map((s) => s.ancestorNode)).toEqual([ANC3]);
    expect(steps.map((s) => s.amount)).toEqual([50n]);
    expect(remainingShortfall).toBe(0n);
    expect(resolveAncestor).toHaveBeenCalledTimes(3); // all walked, two skipped
  });

  it('chain-exhausted: returns the uncovered remainder (>0)', async () => {
    const gc = client(100n, [ANC1, ANC2]);
    const resolveAncestor = vi.fn(async (n: PublicKey) => {
      if (n.equals(ANC1)) return fundingOf(40n); // rem 60
      if (n.equals(ANC2)) return fundingOf(30n); // rem 30, chain ends
      return null;
    });
    const { steps, remainingShortfall } = await gc.cascadeSeize({
      defaultedNode: LEAF,
      dexterAuthority: DEXTER,
      feePayer: FEE_PAYER,
      resolveAncestor,
    });
    expect(steps.map((s) => s.amount)).toEqual([40n, 30n]);
    expect(remainingShortfall).toBe(30n);
  });

  it('throws when the defaulted node is not found', async () => {
    readPrincipalNodeMock.mockResolvedValue(null);
    const gc = new GraphClient({} as any);
    await expect(
      gc.cascadeSeize({
        defaultedNode: LEAF,
        dexterAuthority: DEXTER,
        feePayer: FEE_PAYER,
        resolveAncestor: vi.fn(),
      }),
    ).rejects.toThrow(/not found/);
  });
});
