# Factoring / Instant-Payout Builder Implementation Plan (FULLY WIRED)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a complete, self-contained `@dexterai/vault/factoring` builder: given a LockedClaim and an operator-supplied spread, it produces the full atomic transaction (`settle_locked_voucher` + a Swig SignV2 that splits the payout between the seller and the financier) — runnable end-to-end from the SDK alone, no consumer re-wiring.

**Architecture:** NO on-chain program change. The deployed `settle_locked_voucher` is a two-instruction atomic shape: `[N] vault::settle_locked_voucher` (validates holder + maturity, mutates accumulators) then `[N+1] swig::SignV2(TransferChecked…)` (moves USDC from the swig-wallet ATA, authorized because account[0..1] of settle == `[swig, swig_wallet]` and the settle discriminator is a registered ProgramExec marker). Today settle pays the holder the full claim via one transfer; factoring replaces it with a SPLIT — one SignV2 wrapping one OR two inner `TransferChecked` CPIs (`sellerReceives` → seller ATA, `financierSpread` → financier ATA). This is a verbatim structural port of the PROVEN `dexter-api/src/vault/finalizeWithdrawBuilder.ts#buildFinalizeWithdrawExtra` (which splits a withdrawal into user-receives + fee the same way). The pure split math is unit-tested; the real SignV2 assembly is dependency-injected so the composition is unit-tested too, with the default wiring the real `@swig-wallet/kit` + `@solana-program/token` path the SDK already has installed.

**Tech Stack:** TypeScript, `@solana/web3.js` (`TransactionInstruction`, `Connection`, `PublicKey`), `@swig-wallet/kit` (`fetchSwig`, `getSignInstructions`, `getSwigWalletAddress` — already an SDK dep, used by `swigBundle.ts`), `@solana/kit` (`createSolanaRpc`, `address` — already used by `swigBundle.ts`), `@solana-program/token` (`getTransferCheckedInstruction`, `TOKEN_PROGRAM_ADDRESS` — installed in node_modules, must be added to package.json deps), `@solana/spl-token`'s `getAssociatedTokenAddressSync` (verify availability — else derive via @solana-program/token), `vitest`.

---

## Reference: the proven pattern (READ THESE FIRST — the plan ports them)

- **`dexter-api/src/vault/finalizeWithdrawBuilder.ts#buildFinalizeWithdrawExtra`** — the exact, working split builder. Key pieces to port:
  - `kitInstructionsToWeb3(kitInstructions)` (lines 68–101) — converts `@solana/kit` v2 instructions to web3.js v1 `TransactionInstruction`. **Port this verbatim into the SDK** (the SDK has no such helper yet).
  - `getRpc(connection)` (lines 103–108) — extracts the RPC endpoint from a web3 `Connection` and `createSolanaRpc`s it.
  - `VAULT_PROGRAM_EXEC_ROLE_ID = 1` (line 61) — the swig role index for ProgramExec.
  - The SignV2 call shape: `getSignInstructions(swig, VAULT_PROGRAM_EXEC_ROLE_ID, [transferIx1, transferIx2], false, { payer, preInstructions: [vaultIx] })` (lines 284–291). **The `preInstructions: [settleIx]` is REQUIRED** — Swig's ProgramExec authenticates against exactly ONE preceding instruction; omitting it throws "ProgramExec requires exactly 1 preInstruction".
  - Transfer construction: `getTransferCheckedInstruction({ source, mint, destination, authority: swigWalletKitAddr, amount, decimals }, ...)` — source is the swig-wallet USDC ATA, authority is the swig-wallet kit address.
- **`dexter-api/src/vault/withdrawalFee.ts`** — the POLICY model. Factoring's spread is the analog, but it lives in the CONSUMER, not the SDK. The SDK takes the spread as a param.
- **`src/instructions/swigBundle.ts`** (this SDK) — confirms `@swig-wallet/kit` + `@solana/kit` usage is already native here.
- **`src/instructions/lockedClaim.ts#buildSettleLockedVoucherInstruction`** — the vault ix at index N. Already shipped (Plan 0). Signature: `{ swigAddress, claimPda, vaultPda, holder, dexterAuthority }`.

**Money-flow invariant (settle_locked_voucher.rs header):** the SignV2 transfers source from `swig_wallet_ata`; the total of the inner transfers MUST equal `claim.amount` (cannot transfer more than reserved). `computeFactoringSplit` enforces `sellerReceives + financierSpread === claimAmount`.

---

## File Structure

- **Create:** `src/factoring/split.ts` — PURE split math (`computeFactoringSplit`). No chain deps. The TDD core.
- **Create:** `src/factoring/kitBridge.ts` — `kitInstructionsToWeb3()` + `getRpc()`, ported verbatim from dexter-api. One responsibility: kit↔web3 conversion. (Separate file so it's reusable and independently testable.)
- **Create:** `src/factoring/instantPayout.ts` — `buildInstantPayoutInstructions(params)`: composes `[settleIx, ...signV2Ixs]`. Default SignV2 assembler wires the real swig-kit path; injectable for unit tests.
- **Create:** `src/factoring/index.ts` — barrel.
- **Modify:** `package.json` — add `@solana-program/token` to dependencies; add the `./factoring` subpath to `exports`; (verify `@solana/kit` is a declared dep, add if only transitive).
- **Modify:** `tsup.config.*` — add `src/factoring/index.ts` as a build entry if entries are explicit.
- **Test:** `tests/factoring.split.test.ts` — pure math (TDD core).
- **Test:** `tests/factoring.instantPayout.test.ts` — composition via injected stub (asserts split applied + settle ix shape + preInstructions wiring).

---

## Task 1: Pure factoring split math (the TDD core)

**Files:**
- Create: `src/factoring/split.ts`
- Test: `tests/factoring.split.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/factoring.split.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { computeFactoringSplit } from '../src/factoring/split.js';

describe('computeFactoringSplit', () => {
  it('splits a claim into sellerReceives + financierSpread (the $63 / $0.63 example)', () => {
    const out = computeFactoringSplit({ claimAmount: 63_000_000n, financierSpread: 630_000n });
    expect(out.sellerReceives).toBe(62_370_000n);
    expect(out.financierSpread).toBe(630_000n);
    expect(out.sellerReceives + out.financierSpread).toBe(63_000_000n);
  });

  it('allows a zero spread (seller gets everything)', () => {
    const out = computeFactoringSplit({ claimAmount: 1_000_000n, financierSpread: 0n });
    expect(out.sellerReceives).toBe(1_000_000n);
    expect(out.financierSpread).toBe(0n);
  });

  it('rejects a spread larger than the claim', () => {
    expect(() => computeFactoringSplit({ claimAmount: 1_000_000n, financierSpread: 1_000_001n }))
      .toThrow(/spread exceeds claim/i);
  });

  it('rejects a negative spread', () => {
    expect(() => computeFactoringSplit({ claimAmount: 1_000_000n, financierSpread: -1n }))
      .toThrow(/negative/i);
  });

  it('rejects a zero or negative claim amount', () => {
    expect(() => computeFactoringSplit({ claimAmount: 0n, financierSpread: 0n }))
      .toThrow(/claim amount/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/factoring.split.test.ts`
Expected: FAIL — cannot resolve `../src/factoring/split.js`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/factoring/split.ts`:

```typescript
/**
 * Factoring split math — pure, no chain dependencies.
 *
 * A LockedClaim of `claimAmount` is settled by its holder (the financier).
 * Factoring routes most of that to the SELLER (instant cash now) and keeps a
 * `financierSpread` for the financier — payment-certainty pricing, NOT interest
 * (short claims earn ~nothing on APR; the spread is a clearing/liquidity fee).
 *
 * INVARIANT: sellerReceives + financierSpread === claimAmount, exactly. The two
 * inner SignV2 transfers source from the swig-wallet ATA and together cannot
 * exceed what the claim reserved, so they must sum to the claim amount.
 *
 * The SDK does NOT decide the spread — the caller (operator policy, e.g.
 * dexter-api) supplies it. This keeps the SDK a neutral mechanism.
 */
export interface FactoringSplitParams {
  /** The full LockedClaim amount, atomic units (USDC = 6 decimals). */
  claimAmount: bigint;
  /** The financier's spread, atomic units. 0 ≤ spread ≤ claimAmount. */
  financierSpread: bigint;
}

export interface FactoringSplit {
  /** What the seller receives now (claimAmount - financierSpread). */
  sellerReceives: bigint;
  /** The financier's spread, echoed back for the transfer builder. */
  financierSpread: bigint;
}

export function computeFactoringSplit(p: FactoringSplitParams): FactoringSplit {
  if (p.claimAmount <= 0n) {
    throw new Error(`factoring: claim amount must be positive, got ${p.claimAmount}`);
  }
  if (p.financierSpread < 0n) {
    throw new Error(`factoring: spread must not be negative, got ${p.financierSpread}`);
  }
  if (p.financierSpread > p.claimAmount) {
    throw new Error(`factoring: spread exceeds claim (${p.financierSpread} > ${p.claimAmount})`);
  }
  return {
    sellerReceives: p.claimAmount - p.financierSpread,
    financierSpread: p.financierSpread,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/factoring.split.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/factoring/split.ts tests/factoring.split.test.ts
git commit -m "feat(vault-sdk): factoring split math (pure, neutral — operator supplies spread)"
```

---

## Task 2: Port the kit→web3 bridge into the SDK

**Files:**
- Create: `src/factoring/kitBridge.ts`
- Test: `tests/factoring.kitBridge.test.ts`

The SDK has no `kitInstructionsToWeb3` helper; the real SignV2 assembler needs it. Port it verbatim from `dexter-api/src/vault/finalizeWithdrawBuilder.ts` (lines 68–108) and unit-test the conversion shape.

- [ ] **Step 1: Write the failing test**

Create `tests/factoring.kitBridge.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { kitInstructionsToWeb3 } from '../src/factoring/kitBridge.js';

describe('kitInstructionsToWeb3', () => {
  it('converts a kit instruction (boolean-shape accounts) to a web3 TransactionInstruction', () => {
    const prog = new PublicKey('So11111111111111111111111111111111111111112');
    const acct = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    const kitIx = {
      programAddress: prog.toBase58(),
      accounts: [{ address: acct.toBase58(), signer: true, writable: true }],
      data: new Uint8Array([1, 2, 3]),
    };
    const [web3Ix] = kitInstructionsToWeb3([kitIx]);
    expect(web3Ix.programId.equals(prog)).toBe(true);
    expect(web3Ix.keys.length).toBe(1);
    expect(web3Ix.keys[0].pubkey.equals(acct)).toBe(true);
    expect(web3Ix.keys[0].isSigner).toBe(true);
    expect(web3Ix.keys[0].isWritable).toBe(true);
    expect(Array.from(web3Ix.data)).toEqual([1, 2, 3]);
  });

  it('handles numeric role accounts (role>=2 signer, odd role writable)', () => {
    const prog = new PublicKey('So11111111111111111111111111111111111111112');
    const acct = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    const kitIx = { programAddress: prog.toBase58(), accounts: [{ address: acct.toBase58(), role: 3 }], data: new Uint8Array() };
    const [web3Ix] = kitInstructionsToWeb3([kitIx]);
    expect(web3Ix.keys[0].isSigner).toBe(true);  // role 3 >= 2
    expect(web3Ix.keys[0].isWritable).toBe(true); // role 3 odd
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/factoring.kitBridge.test.ts`
Expected: FAIL — cannot resolve `../src/factoring/kitBridge.js`.

- [ ] **Step 3: Port the bridge verbatim**

Create `src/factoring/kitBridge.ts` (ported from dexter-api/src/vault/finalizeWithdrawBuilder.ts:64–108 — keep behavior identical):

```typescript
/**
 * Kit v2 → Web3.js v1 instruction converter + RPC extractor.
 * Ported verbatim from dexter-api/src/vault/finalizeWithdrawBuilder.ts
 * (mirrors swigAdapter.ts kitInstructionsToWeb3 — keep in sync). The @swig-wallet/kit
 * SignV2 path emits kit-v2 instructions; the rest of the SDK speaks web3.js v1.
 */
import { PublicKey, TransactionInstruction, Connection } from '@solana/web3.js';
import { createSolanaRpc } from '@solana/kit';

export function kitInstructionsToWeb3(kitInstructions: any[]): TransactionInstruction[] {
  return kitInstructions.map((ix) => {
    const accounts = (ix.accounts ?? []).map((acc: any) => {
      const role = acc.role;
      const hasBooleanShape = typeof acc.signer === 'boolean' || typeof acc.writable === 'boolean';
      let isSigner = false;
      let isWritable = false;
      if (hasBooleanShape) {
        isSigner = Boolean(acc.signer);
        isWritable = Boolean(acc.writable);
      } else if (typeof role === 'number') {
        isSigner = role >= 2;
        isWritable = role % 2 === 1;
      } else if (typeof role === 'string') {
        const r = role.toLowerCase();
        isSigner = r.endsWith('signer');
        isWritable = r.startsWith('writable');
      }
      const addressSource = acc.address ?? acc.publicKey;
      const pubkey =
        addressSource instanceof PublicKey
          ? addressSource
          : typeof addressSource === 'string'
            ? new PublicKey(addressSource)
            : new PublicKey(String(addressSource));
      return { pubkey, isSigner, isWritable };
    });
    return new TransactionInstruction({
      programId: new PublicKey(ix.programAddress ?? ix.programId),
      keys: accounts,
      data: Buffer.from(ix.data ?? []),
    });
  });
}

export function getRpc(connection: Connection): any {
  const endpoint = (connection as any)._rpcEndpoint ?? (connection as any).rpcEndpoint;
  if (!endpoint) throw new Error('factoring: cannot extract RPC endpoint from connection');
  return createSolanaRpc(endpoint);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/factoring.kitBridge.test.ts`
Expected: PASS (2 tests). If `@solana/kit` import fails to resolve at build/test time, add it to package.json dependencies (Step in Task 4) — it's already in node_modules.

- [ ] **Step 5: Commit**

```bash
git add src/factoring/kitBridge.ts tests/factoring.kitBridge.test.ts
git commit -m "feat(vault-sdk): port kit->web3 instruction bridge for SignV2 assembly"
```

---

## Task 3: Instant-payout composition + real SignV2 assembler

**Files:**
- Create: `src/factoring/instantPayout.ts`
- Test: `tests/factoring.instantPayout.test.ts`

- [ ] **Step 1: Write the failing test (composition via injected stub)**

Create `tests/factoring.instantPayout.test.ts`:

```typescript
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
      // The settle ix MUST be threaded as the single preInstruction (Swig ProgramExec).
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

    expect(ixs.length).toBe(2);          // [settleIx, stubSignV2]
    expect(ixs[0].keys.length).toBe(6);  // settle_locked_voucher
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/factoring.instantPayout.test.ts`
Expected: FAIL — cannot resolve `../src/factoring/instantPayout.js`.

- [ ] **Step 3: Write the composition + real default assembler**

Create `src/factoring/instantPayout.ts`:

```typescript
/**
 * Instant-payout (factoring) — full atomic transaction assembly.
 *
 *   [0] vault::settle_locked_voucher  (financier = holder; validates + mutates)
 *   [1] swig::SignV2(TransferChecked × {1 or 2})  (sourced from swig_wallet_ata)
 *         - sellerReceives  → sellerAta
 *         - financierSpread → financierAta  (omitted when spread === 0)
 *
 * The default `assembleSignV2` wires the real @swig-wallet/kit + @solana-program/token
 * path (mirrors dexter-api buildFinalizeWithdrawExtra). It's injectable so the
 * composition is unit-testable without live swig state.
 */
import { PublicKey, TransactionInstruction, Connection } from '@solana/web3.js';
import { fetchSwig, getSignInstructions, getSwigWalletAddress } from '@swig-wallet/kit';
import { address as kitAddress } from '@solana/kit';
import { getTransferCheckedInstruction } from '@solana-program/token';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { buildSettleLockedVoucherInstruction } from '../instructions/lockedClaim.js';
import { USDC_MAINNET } from '../constants/index.js';
import { computeFactoringSplit } from './split.js';
import { kitInstructionsToWeb3, getRpc } from './kitBridge.js';

const VAULT_PROGRAM_EXEC_ROLE_ID = 1; // swig role index for ProgramExec (see dexter-api)
const USDC_DECIMALS = 6;

export interface InstantTransfer {
  destinationAta: PublicKey;
  amount: bigint;
}

export interface AssembleSignV2Args {
  connection: Connection;
  swigAddress: PublicKey;
  feePayer: PublicKey;
  /** The single preceding instruction Swig ProgramExec authenticates against. */
  settleIx: TransactionInstruction;
  transfers: InstantTransfer[];
}

export type AssembleSignV2 = (args: AssembleSignV2Args) => Promise<TransactionInstruction[]>;

export interface InstantPayoutParams {
  connection: Connection;
  swigAddress: PublicKey;
  claimPda: PublicKey;
  vaultPda: PublicKey;
  /** The current claim holder collecting — the financier. Signs settle. */
  financier: PublicKey;
  dexterAuthority: PublicKey;
  claimAmount: bigint;
  /** Operator-supplied spread. 0 ≤ spread ≤ claimAmount. */
  financierSpread: bigint;
  sellerAta: PublicKey;
  financierAta: PublicKey;
  /** Pays ATA rent / tx fees in the SignV2 build. */
  feePayer: PublicKey;
  /** Injectable for unit tests; defaults to the real swig-kit assembler. */
  assembleSignV2?: AssembleSignV2;
}

export async function buildInstantPayoutInstructions(
  p: InstantPayoutParams,
): Promise<TransactionInstruction[]> {
  const split = computeFactoringSplit({
    claimAmount: p.claimAmount,
    financierSpread: p.financierSpread,
  });

  const settleIx = buildSettleLockedVoucherInstruction({
    swigAddress: p.swigAddress,
    claimPda: p.claimPda,
    vaultPda: p.vaultPda,
    holder: p.financier,
    dexterAuthority: p.dexterAuthority,
  });

  const transfers: InstantTransfer[] = [
    { destinationAta: p.sellerAta, amount: split.sellerReceives },
  ];
  if (split.financierSpread > 0n) {
    transfers.push({ destinationAta: p.financierAta, amount: split.financierSpread });
  }

  const assemble = p.assembleSignV2 ?? defaultAssembleSignV2;
  const signV2Ixs = await assemble({
    connection: p.connection,
    swigAddress: p.swigAddress,
    feePayer: p.feePayer,
    settleIx,
    transfers,
  });

  return [settleIx, ...signV2Ixs];
}

/** Real SignV2 assembler — mirrors dexter-api buildFinalizeWithdrawExtra. */
const defaultAssembleSignV2: AssembleSignV2 = async (a) => {
  const rpc = getRpc(a.connection);
  const swig = await fetchSwig(rpc, kitAddress(a.swigAddress.toBase58()));
  if (!swig) throw new Error(`factoring: swig not found on-chain: ${a.swigAddress.toBase58()}`);

  const swigWalletKitAddr = await getSwigWalletAddress(swig);
  const swigWalletPda = new PublicKey(String(swigWalletKitAddr));
  const usdcMint = new PublicKey(USDC_MAINNET);
  const sourceAta = getAssociatedTokenAddressSync(usdcMint, swigWalletPda, true);

  const transferIxs = a.transfers.map((t) =>
    getTransferCheckedInstruction({
      source: kitAddress(sourceAta.toBase58()),
      mint: kitAddress(usdcMint.toBase58()),
      destination: kitAddress(t.destinationAta.toBase58()),
      authority: swigWalletKitAddr,
      amount: t.amount,
      decimals: USDC_DECIMALS,
    }),
  );

  const signIx = await getSignInstructions(
    swig,
    VAULT_PROGRAM_EXEC_ROLE_ID,
    transferIxs as any,
    false,
    { payer: kitAddress(a.feePayer.toBase58()), preInstructions: [a.settleIx] } as any,
  );

  return kitInstructionsToWeb3(signIx);
};
```

IMPLEMENTER NOTES:
- Verify `getAssociatedTokenAddressSync` is importable from `@solana/spl-token` (check it's an SDK dep; if the SDK uses a different ATA derivation, match that — `dexter-api` imports it from `@solana/spl-token`). If `@solana/spl-token` is NOT available, derive the ATA via `@solana-program/token`'s `findAssociatedTokenPda` instead and adapt.
- The `getTransferCheckedInstruction` / `getSignInstructions` arg shapes are taken from dexter-api's working code (finalizeWithdrawBuilder.ts:266–291). If the installed `@solana-program/token` / `@swig-wallet/kit` versions differ from dexter-api's and the arg shape doesn't compile, READ the installed package's types and adapt — the dexter-api call is the semantic reference, not a guaranteed signature match across versions.
- The unit test injects `assembleSignV2`, so `defaultAssembleSignV2` is NOT exercised by tests (it needs live swig). That's expected — its correctness is proven by being a structural port of code already running in dexter-api production, and by the integration/demo layer.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/factoring.instantPayout.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: tsc + full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: tsc exit 0; all tests pass (89 prior + split 5 + kitBridge 2 + instantPayout 2).
If tsc fails on the `@solana-program/token` / `@swig-wallet/kit` arg shapes, fix per the IMPLEMENTER NOTES (adapt to installed types). Do NOT weaken the test to make it pass.

- [ ] **Step 6: Commit**

```bash
git add src/factoring/instantPayout.ts tests/factoring.instantPayout.test.ts
git commit -m "feat(vault-sdk): instant-payout builder — settle + real split SignV2 (fully wired)"
```

---

## Task 4: Dependencies, barrel, subpath export

**Files:**
- Create: `src/factoring/index.ts`
- Modify: `package.json` (deps + exports), `tsup.config.*` (entry)

- [ ] **Step 1: Declare the deps**

Confirm what's actually imported and ensure each is in `package.json` dependencies (they're installed in node_modules but may only be transitive):
Run: `node -e "const d=require('./package.json').dependencies; for(const k of ['@solana-program/token','@solana/kit','@swig-wallet/kit','@solana/spl-token']) console.log(k, d[k]||'MISSING')"`
For each `MISSING` that the factoring code imports, add it with the version from node_modules:
Run (example): `node -e "console.log(require('@solana-program/token/package.json').version)"` then add `"@solana-program/token": "^<version>"` to dependencies. Do the same for any other MISSING import. (`@swig-wallet/kit` is already present.)

- [ ] **Step 2: Create the barrel**

Create `src/factoring/index.ts`:

```typescript
export { computeFactoringSplit } from './split.js';
export type { FactoringSplit, FactoringSplitParams } from './split.js';
export { buildInstantPayoutInstructions } from './instantPayout.js';
export type {
  InstantPayoutParams,
  InstantTransfer,
  AssembleSignV2,
  AssembleSignV2Args,
} from './instantPayout.js';
export { kitInstructionsToWeb3, getRpc } from './kitBridge.js';
```

- [ ] **Step 3: Add the subpath export + build entry**

In `package.json` `exports`, copy the existing `./instructions` block and rename to `./factoring`, pointing at `dist/factoring/index.*` (match the exact condition shape — import/require/types). If `tsup.config.*` lists explicit entries, add `src/factoring/index.ts`.

- [ ] **Step 4: Build + verify subpath resolves**

Run: `npx tsc --noEmit && npm run build`
Expected: build succeeds, emits `dist/factoring/index.*`.
Run: `node -e "const m=require('./dist/factoring/index.cjs'); console.log('split:'+typeof m.computeFactoringSplit,'payout:'+typeof m.buildInstantPayoutInstructions,'bridge:'+typeof m.kitInstructionsToWeb3)"`
Expected: all three `:function`.

- [ ] **Step 5: Full suite**

Run: `npx vitest run`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/factoring/index.ts package.json
git commit -m "feat(vault-sdk): export @dexterai/vault/factoring subpath + declare deps"
```
(Add `tsup.config.*` if edited.)

---

## Task 5: CHANGELOG

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add the factoring entry under the existing 0.4.2 `### Added`**

Add a bullet (match the existing style):
```markdown
- **Factoring / instant-payout** (`@dexterai/vault/factoring`) — `computeFactoringSplit` (pure split math) + `buildInstantPayoutInstructions` (settles a LockedClaim and splits the payout: seller gets instant cash, financier keeps the spread — one atomic `settle_locked_voucher` + Swig SignV2). The spread is caller-supplied (neutral mechanism; operator sets policy). Fully wired against `@swig-wallet/kit` + `@solana-program/token`.
```

- [ ] **Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(vault-sdk): changelog — factoring/instant-payout builder"
```

---

## Final verification (after all tasks)

- [ ] `npx vitest run` — all green (89 prior + 9 new factoring).
- [ ] `npm run build` — clean; `dist/factoring/` emitted; subpath resolves.
- [ ] NO version bump, NO `npm publish` — Branch-gated.
- [ ] NO on-chain program change — confirm nothing under `../dexter-vault/programs/` touched.
- [ ] The default SignV2 assembler is a structural port of dexter-api's production `buildFinalizeWithdrawExtra` — if any arg shape was adapted to installed package versions, note it in the commit body.

---

## Notes for the executor

- **Factoring is NOT credit.** Nobody goes negative; the buyer's funds back the claim fully. The financier buys the claim (already-shipped `transfer_lock_ownership`) and settles, advancing the seller cash. The spread is a clearing/liquidity FEE, not interest. (Ε design-lock: `dexter-thesis/specs/2026-06-06-epsilon-credit-design-lock.md`.)
- **The SDK is a neutral mechanism** — spread is a parameter, never hardcoded. Operator policy lives in the consumer (like `dexter-api/src/vault/withdrawalFee.ts`).
- **Total inner transfers === claim amount** — enforced by `computeFactoringSplit`. Cannot exceed what the claim reserved from the swig-wallet ATA.
- **The real SignV2 path is a verbatim structural port** of `dexter-api/src/vault/finalizeWithdrawBuilder.ts` — proven in production. The `preInstructions: [settleIx]` is mandatory (Swig ProgramExec authenticates exactly one preceding ix). Adapt arg shapes to installed package versions if needed, keeping the semantics.
- **Do NOT publish, do NOT bump version.** Source only.
- **This unblocks** the demo's instant-payout stage AND gives Credit-L2 (Plan 3) a proven split-SignV2 pattern for the borrow/repay transfers.
