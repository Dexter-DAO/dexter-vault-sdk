# The `./tab` Product Layer + SDK Cleanup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `@dexterai/vault` from a byte-precise parts-box into a parts-box + a first-class product layer, by promoting the proven tab/credit settlement loop into a new `./tab` subpath (additively, breaking no consumer), deduping the kit bridge helper into `./kit`, and rewriting the stale README product-first.

**Architecture:** Organize by capability, not audience. `./tab` is a composed-operation subpath, sibling to the existing `./factoring` — every verb takes a flat params object, returns `Promise<TransactionInstruction[]>`, and uses an injectable `assembleSignV2` that defaults to the real Swig kit (the proven `instantPayout.ts` shape). The SDK gets the recipe (compose instructions); consumers keep the kitchen (fees, sending, keys). Nothing is sent, nothing renamed, nothing hidden.

**Tech Stack:** TypeScript, `@solana/web3.js` v1, `@swig-wallet/kit` (SignV2), `@solana-program/token`, `@solana/kit`, vitest, tsup. Design spec: `docs/superpowers/specs/2026-06-07-tab-product-layer-design.md`.

**Working dir for all tasks:** `/home/branchmanager/websites/dexter-vault-sdk`

**Global rules:** NO publish, NO version bump beyond what a task specifies. Branch on `main` (Branch's standing consent). All instruction-composition verbs RETURN instructions; never build+sign+send. Never hide/rename an existing export. Run `npx vitest run` + `npx tsc --noEmit` green before each commit.

---

## File Structure

**Piece 1 — `./kit` (dedup the bridge helper):**
- Create: `src/kit/index.ts` — the single home for `kitInstructionsToWeb3` + `getRpc`.
- Modify: `src/factoring/kitBridge.ts` — becomes a re-export of `../kit/` (back-compat, zero churn for factoring's internal imports).
- Modify: `package.json` — add `./kit` to `exports`; add `src/kit/index.ts` to tsup entries.
- Test: `tests/kit.test.ts`.

**Piece 2 — `./tab` (the product layer):**
- Create: `src/tab/types.ts` — shared param/result types for the verbs.
- Create: `src/tab/assembleSignV2.ts` — the default real Swig assembler + the injectable type (shared by tab + credit verbs).
- Create: `src/tab/settleTab.ts` — `settleTab` (the central verb; reads chain for prior-spent).
- Create: `src/tab/openTab.ts` — `openTab`.
- Create: `src/tab/readTabMeter.ts` — `readTabMeter` (read-only reporter).
- Create: `src/tab/credit.ts` — `drawCredit`, `repayCredit`, `seizeCollateral`.
- Create: `src/tab/index.ts` — re-exports the whole `./tab` surface.
- Modify: `package.json` — add `./tab` to `exports` + tsup entries.
- Test: `tests/tab.settleTab.test.ts`, `tests/tab.openTab.test.ts`, `tests/tab.readTabMeter.test.ts`, `tests/tab.credit.test.ts`.

**Piece 3 — README:**
- Modify: `README.md`.
- Modify: `CHANGELOG.md`.

---

## PIECE 1 — `./kit` dedup

### Task 1: Create the `./kit` subpath as the bridge helper's single home

**Files:**
- Create: `src/kit/index.ts`
- Test: `tests/kit.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/kit.test.ts`:
```ts
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
      accounts: [{ publicKey: 'So11111111111111111111111111111111111111112', role: 3 }], // 3 = signer+writable
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/branchmanager/websites/dexter-vault-sdk && npx vitest run tests/kit.test.ts`
Expected: FAIL — `Cannot find module '../src/kit/index.js'`.

- [ ] **Step 3: Create `src/kit/index.ts`**

Move the verbatim bridge code out of `src/factoring/kitBridge.ts` into `src/kit/index.ts` (identical logic — it is already proven):
```ts
/**
 * Kit v2 → Web3.js v1 instruction converter + RPC extractor.
 * The single home for the Swig-kit↔web3 bridge. Both ./factoring and ./tab
 * (and the program test suites) import from here — one copy, no drift.
 * Originally duplicated across 8 files; consolidated 2026-06-07.
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
  if (!endpoint) throw new Error('kit: cannot extract RPC endpoint from connection');
  return createSolanaRpc(endpoint);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/kit.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**
```bash
git add src/kit/index.ts tests/kit.test.ts
git commit -m "feat(sdk): ./kit — single home for the swig-kit→web3 bridge helper"
```

### Task 2: Re-point `./factoring` at `./kit` and wire the `./kit` export

**Files:**
- Modify: `src/factoring/kitBridge.ts`
- Modify: `src/factoring/index.ts:11` (currently `export { kitInstructionsToWeb3, getRpc } from './kitBridge.js';`)
- Modify: `package.json`

- [ ] **Step 1: Turn `kitBridge.ts` into a re-export (no behavior change, zero churn for factoring's internal imports)**

Replace the entire body of `src/factoring/kitBridge.ts` with:
```ts
/**
 * Back-compat shim. The bridge helper now lives in ../kit (single home).
 * Kept so existing `./factoring/kitBridge.js` imports keep working; new code
 * should import from `@dexterai/vault/kit`.
 */
export { kitInstructionsToWeb3, getRpc } from '../kit/index.js';
```

- [ ] **Step 2: Add `./kit` to `package.json` exports + tsup entry**

In `package.json` `exports`, after the `"./counterfactual"` block (alphabetical-ish, but placement is cosmetic), add:
```jsonc
    "./kit": {
      "types": "./dist/kit/index.d.ts",
      "import": "./dist/kit/index.js",
      "require": "./dist/kit/index.cjs"
    },
```
Then check `tsup.config.ts` — if `entry` is an explicit array, add `'src/kit/index.ts'`. (If it globs `src/**/index.ts` or similar, no change needed; verify by reading the file.)

- [ ] **Step 3: Run the full suite + typecheck + build to verify nothing broke**

Run: `npx tsc --noEmit && npx vitest run && npm run build`
Expected: all green. Factoring tests still pass (they import the shim, which re-exports the identical code). Build emits `dist/kit/index.{js,cjs,d.ts}`.

- [ ] **Step 4: Commit**
```bash
git add src/factoring/kitBridge.ts package.json tsup.config.ts
git commit -m "refactor(sdk): factoring imports the bridge from ./kit; export ./kit subpath"
```

---

## PIECE 2 — `./tab` product layer

### Task 3: `./tab` shared types + the injectable assembler

**Files:**
- Create: `src/tab/types.ts`
- Create: `src/tab/assembleSignV2.ts`
- Test: `tests/tab.assembleSignV2.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/tab.assembleSignV2.test.ts`:
```ts
import { describe, test, expect } from 'vitest';
import type { AssembleSignV2, AssembleSignV2Args } from '../src/tab/assembleSignV2.js';
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
      feePayer: new PublicKey('Sysvar1nstructions1111111111111111111111111'),
      vaultIx: marker,
      transfers: [{ destinationAta: new PublicKey('So11111111111111111111111111111111111111112'), amount: 1n }],
    });
    expect(out).toEqual([marker]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tab.assembleSignV2.test.ts`
Expected: FAIL — `Cannot find module '../src/tab/assembleSignV2.js'`.

- [ ] **Step 3: Create the types + assembler**

Create `src/tab/types.ts`:
```ts
import type { PublicKey } from '@solana/web3.js';

/** A single SignV2 transfer leg (destination + amount). */
export interface TabTransfer {
  destinationAta: PublicKey;
  amount: bigint;
}
```

Create `src/tab/assembleSignV2.ts` (adapted from `factoring/instantPayout.ts`'s assembler — note `settleIx` is generalized to `vaultIx` since tab/credit have different leading instructions):
```ts
/**
 * The injectable Swig SignV2 assembler for ./tab verbs. Default wires the real
 * @swig-wallet/kit; tests inject a fake. Mirrors factoring/instantPayout.ts.
 * The vault instruction (settle_tab_voucher / draw_credit / etc.) is passed as
 * `vaultIx` and becomes the SignV2 preInstruction.
 */
import { PublicKey, TransactionInstruction, Connection } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { fetchSwig, getSignInstructions, getSwigWalletAddress } from '@swig-wallet/kit';
import { address as kitAddress } from '@solana/kit';
import { getTransferCheckedInstruction } from '@solana-program/token';
import { USDC_MAINNET } from '../constants/index.js';
import { kitInstructionsToWeb3, getRpc } from '../kit/index.js';
import type { TabTransfer } from './types.js';

const USDC_DECIMALS = 6;
// The Swig role carrying the vault ProgramExec marker. Matches factoring's
// VAULT_PROGRAM_EXEC_ROLE_ID; the swig the SignV2 spends must have the relevant
// instruction's discriminator registered as a ProgramExec marker on this role.
const VAULT_PROGRAM_EXEC_ROLE_ID = 1;

export interface AssembleSignV2Args {
  connection: Connection;
  /** The swig whose wallet ATA funds the transfer (USER swig for tab/repay/seize, FINANCIER swig for draw). */
  swigAddress: PublicKey;
  feePayer: PublicKey;
  /** The preceding vault instruction (settle_tab_voucher / draw_credit / repay_credit / seize_collateral). */
  vaultIx: TransactionInstruction;
  transfers: TabTransfer[];
}

export type AssembleSignV2 = (args: AssembleSignV2Args) => Promise<TransactionInstruction[]>;

export const defaultAssembleSignV2: AssembleSignV2 = async (a) => {
  const rpc = getRpc(a.connection);
  const swig = await fetchSwig(rpc, kitAddress(a.swigAddress.toBase58()));
  if (!swig) throw new Error(`tab: swig not found on-chain: ${a.swigAddress.toBase58()}`);

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
    { payer: kitAddress(a.feePayer.toBase58()), preInstructions: [a.vaultIx] } as any,
  );

  return kitInstructionsToWeb3(signIx);
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/tab.assembleSignV2.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/tab/types.ts src/tab/assembleSignV2.ts tests/tab.assembleSignV2.test.ts
git commit -m "feat(sdk): ./tab shared types + injectable SignV2 assembler (default real swig)"
```

### Task 4: `settleTab` — the central verb (reads chain for prior-spent)

**Files:**
- Create: `src/tab/settleTab.ts`
- Test: `tests/tab.settleTab.test.ts`

**Context for the implementer:** `settleTab` composes `[Ed25519 precompile over the 44-byte voucher] + [settle_tab_voucher vault ix] + [Swig SignV2 transfer of the delta]`. The delta = `cumulativeAmount - priorSpent`, where `priorSpent` is read fresh from chain via `readVaultFull` (the freshness-read lives INSIDE the verb). The voucher message is built with `voucherPayloadMessage(channelId, cumulativeAmount, sequenceNumber)` from `../messages/`. The session signs it (Ed25519). To keep the verb unit-testable without chain/Swig, BOTH the chain-read and the assembler are injectable (default real).

- [ ] **Step 1: Write the failing test**

Create `tests/tab.settleTab.test.ts`:
```ts
import { describe, test, expect } from 'vitest';
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { settleTab } from '../src/tab/settleTab.js';

const VAULT = new PublicKey('SysvarC1ock11111111111111111111111111111111');
const SWIG = new PublicKey('SysvarRent111111111111111111111111111111111');
const MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const SELLER_ATA = new PublicKey('So11111111111111111111111111111111111111112');
const FEEPAYER = new PublicKey('11111111111111111111111111111111');

// Fake session signer: returns a deterministic 64-byte signature.
const sessionSigner = {
  publicKey: new Uint8Array(32).fill(7),
  sign: async (_m: Uint8Array) => new Uint8Array(64).fill(9),
};

describe('settleTab', () => {
  test('reads prior-spent, computes the delta, and composes precompile + vault ix + SignV2', async () => {
    let assemblerSawDelta: bigint | undefined;
    const fakeAssemble = async (a: any) => {
      assemblerSawDelta = a.transfers[0].amount;
      return [new TransactionInstruction({ programId: SWIG, keys: [], data: Buffer.from([0x5a]) })];
    };
    const ixs = await settleTab({
      connection: {} as any,
      vaultPda: VAULT,
      swigAddress: SWIG,
      channelId: new Uint8Array(32).fill(1),
      cumulativeAmount: 5_000_000n,
      sequenceNumber: 3,
      sessionSigner,
      mint: MINT,
      sellerAta: SELLER_ATA,
      feePayer: FEEPAYER,
      assembleSignV2: fakeAssemble,
      readPriorSpent: async () => 2_000_000n, // injected chain-read
    });
    // delta = 5,000,000 - 2,000,000
    expect(assemblerSawDelta).toBe(3_000_000n);
    // composed shape: [precompile, vaultIx, ...signV2]
    expect(ixs.length).toBeGreaterThanOrEqual(3);
    // first ix is the Ed25519 precompile (Ed25519 program id)
    expect(ixs[0].programId.equals(new PublicKey('Ed25519SigVerify111111111111111111111111111'))).toBe(true);
    // last ix is the assembler's SignV2 output
    expect(Array.from(ixs[ixs.length - 1].data)).toEqual([0x5a]);
  });

  test('rejects a non-monotonic settle (cumulative <= priorSpent)', async () => {
    await expect(
      settleTab({
        connection: {} as any,
        vaultPda: VAULT, swigAddress: SWIG,
        channelId: new Uint8Array(32).fill(1),
        cumulativeAmount: 2_000_000n, sequenceNumber: 3,
        sessionSigner, mint: MINT, sellerAta: SELLER_ATA, feePayer: FEEPAYER,
        assembleSignV2: async () => [],
        readPriorSpent: async () => 2_000_000n,
      }),
    ).rejects.toThrow(/non-monotonic|cumulative/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tab.settleTab.test.ts`
Expected: FAIL — `Cannot find module '../src/tab/settleTab.js'`.

- [ ] **Step 3: Implement `src/tab/settleTab.ts`**

```ts
/**
 * settleTab — the central ./tab verb. Composes the atomic 3-instruction tab
 * settle: [Ed25519 precompile over the voucher] + [settle_tab_voucher] +
 * [Swig SignV2 transfer of the delta]. The delta (cumulative - priorSpent) is
 * computed from a FRESH on-chain read done INSIDE this verb (the freshness-read
 * can't be gotten wrong by the caller). On-chain settle_tab_voucher re-validates
 * monotonicity + cap, so a stale read fails safe on-chain.
 *
 * Returns instructions; does NOT send. Promoted from dexter-facilitator/src/tabSettle.ts.
 */
import { Connection, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { voucherPayloadMessage } from '../messages/index.js';
import { buildEd25519VerifyInstruction } from '../precompile/index.js';
import { buildSettleTabVoucherInstruction } from '../instructions/index.js';
import { readVaultFull } from '../reader/index.js';
import type { Ed25519Signer } from '../signers/types.js';
import { defaultAssembleSignV2, type AssembleSignV2 } from './assembleSignV2.js';

export interface SettleTabParams {
  connection: Connection;
  vaultPda: PublicKey;
  /** The USER's swig — its wallet ATA funds the tab payment. */
  swigAddress: PublicKey;
  channelId: Uint8Array;        // 32 bytes
  cumulativeAmount: bigint;     // running total; the delta is computed internally
  sequenceNumber: number;       // u32
  sessionSigner: Ed25519Signer; // signs the 44-byte voucher payload
  mint: PublicKey;
  sellerAta: PublicKey;
  feePayer: PublicKey;
  dexterAuthority?: PublicKey;   // defaults handled by the vault ix builder if omitted
  /** Injectable; defaults to the real Swig assembler. */
  assembleSignV2?: AssembleSignV2;
  /** Injectable chain-read of prior spent; defaults to readVaultFull. */
  readPriorSpent?: (connection: Connection, vaultPda: PublicKey) => Promise<bigint>;
}

const defaultReadPriorSpent = async (connection: Connection, vaultPda: PublicKey): Promise<bigint> => {
  const vault = await readVaultFull(connection, vaultPda);
  const session = vault.activeSession;
  if (!session) throw new Error('settleTab: no active session on vault');
  // VERIFIED against src/reader/accountReader.ts: activeSession.spent is a
  // native bigint (readBigUInt64LE) — NOT a BN, no .toString() needed.
  return session.spent;
};

export async function settleTab(p: SettleTabParams): Promise<TransactionInstruction[]> {
  const readPrior = p.readPriorSpent ?? defaultReadPriorSpent;
  const priorSpent = await readPrior(p.connection, p.vaultPda);

  if (p.cumulativeAmount <= priorSpent) {
    throw new Error(
      `settleTab: non-monotonic cumulative — ${p.cumulativeAmount} <= prior spent ${priorSpent}`,
    );
  }
  const delta = p.cumulativeAmount - priorSpent;

  // 1. Ed25519 precompile over the canonical 44-byte voucher payload.
  const message = voucherPayloadMessage(p.channelId, p.cumulativeAmount, p.sequenceNumber);
  const signature = await p.sessionSigner.sign(message);
  const precompileIx = buildEd25519VerifyInstruction(p.sessionSigner.publicKey, signature, message);

  // 2. settle_tab_voucher vault instruction.
  const vaultIx = buildSettleTabVoucherInstruction({
    vaultPda: p.vaultPda,
    channelId: p.channelId,
    cumulativeAmount: p.cumulativeAmount,
    sequenceNumber: p.sequenceNumber,
    ...(p.dexterAuthority ? { dexterAuthority: p.dexterAuthority } : {}),
  } as any);

  // 3. Swig SignV2 transfer of the delta (the assembler bundles vaultIx as the preInstruction).
  const assemble = p.assembleSignV2 ?? defaultAssembleSignV2;
  const signV2Ixs = await assemble({
    connection: p.connection,
    swigAddress: p.swigAddress,
    feePayer: p.feePayer,
    vaultIx,
    transfers: [{ destinationAta: p.sellerAta, amount: delta }],
  });

  return [precompileIx, vaultIx, ...signV2Ixs];
}
```

**Implementer note:** verify the real signatures of `buildSettleTabVoucherInstruction`, `buildEd25519VerifyInstruction`, `voucherPayloadMessage`, and `readVaultFull` against their source files before finalizing — adjust the call sites to match exactly (the shapes above mirror the existing usages in `tests/byte-parity.test.ts` and `dexter-facilitator/src/tabSettle.ts`, but confirm field names like `spent` on the session reader). If `buildSettleTabVoucherInstruction` already includes the precompile or has a different arg set, adapt — the COMPOSITION (precompile, vault ix, SignV2) and the delta math are the locked contract; the exact builder call adapts to reality.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/tab.settleTab.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**
```bash
git add src/tab/settleTab.ts tests/tab.settleTab.test.ts
git commit -m "feat(sdk): settleTab — atomic tab settle, internal freshness-read for the delta"
```

### Task 5: `openTab` + `readTabMeter`

**Files:**
- Create: `src/tab/openTab.ts`
- Create: `src/tab/readTabMeter.ts`
- Test: `tests/tab.openTab.test.ts`, `tests/tab.readTabMeter.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/tab.readTabMeter.test.ts` (NOTE: field names match the REAL `ActiveSession` from `src/reader/accountReader.ts` — `maxAmount` + `spent`, both native `bigint`. There is no `currentOutstanding`/`maxRevolvingCapacity` on this reader; the meter is computed from the cap (`maxAmount`) and `spent`):
```ts
import { describe, test, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { readTabMeter } from '../src/tab/readTabMeter.js';

describe('readTabMeter', () => {
  test('reports spent/cap/remaining; never throws (report, not refuse)', async () => {
    const fakeRead = async () => ({
      activeSession: { spent: 3_000_000n, maxAmount: 5_000_000n },
    });
    const m = await readTabMeter({} as any, new PublicKey('SysvarC1ock11111111111111111111111111111111'), fakeRead as any);
    expect(m.spent).toBe(3_000_000n);
    expect(m.maxAmount).toBe(5_000_000n);
    expect(m.remaining).toBe(2_000_000n); // cap - spent
  });

  test('remaining clamps at 0 (never negative) and does NOT throw when spent exceeds cap', async () => {
    const fakeRead = async () => ({
      activeSession: { spent: 6_000_000n, maxAmount: 5_000_000n },
    });
    const m = await readTabMeter({} as any, new PublicKey('SysvarC1ock11111111111111111111111111111111'), fakeRead as any);
    expect(m.remaining).toBe(0n);
  });
});
```

Create `tests/tab.openTab.test.ts`:
```ts
import { describe, test, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { openTab } from '../src/tab/openTab.js';

describe('openTab', () => {
  test('composes the settle_voucher(increment) leg and returns instructions', async () => {
    const ixs = await openTab({
      vaultPda: new PublicKey('SysvarC1ock11111111111111111111111111111111'),
      swigAddress: new PublicKey('SysvarRent111111111111111111111111111111111'),
      amount: 1_000_000n,
      dexterAuthority: new PublicKey('11111111111111111111111111111111'),
    });
    expect(Array.isArray(ixs)).toBe(true);
    expect(ixs.length).toBeGreaterThanOrEqual(1);
    expect(ixs[0].programId.equals(new PublicKey('Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/tab.readTabMeter.test.ts tests/tab.openTab.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement both**

Create `src/tab/readTabMeter.ts` (field names VERIFIED against `src/reader/accountReader.ts`: `activeSession` has `maxAmount` and `spent`, both native `bigint`. The cap is `maxAmount`; remaining = cap − spent):
```ts
/**
 * readTabMeter — READ-ONLY tab reporter. Reports remaining headroom under the
 * session cap; NEVER refuses. The on-chain cap guard is authoritative; a
 * client-side refuser would invite a stale-cache TOCTOU bug.
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { readVaultFull } from '../reader/index.js';

export interface TabMeter {
  spent: bigint;        // activeSession.spent
  maxAmount: bigint;    // activeSession.maxAmount — the session cap
  remaining: bigint;    // max(0, maxAmount - spent)
}

export async function readTabMeter(
  connection: Connection,
  vaultPda: PublicKey,
  read: (c: Connection, v: PublicKey) => Promise<any> = readVaultFull,
): Promise<TabMeter> {
  const vault = await read(connection, vaultPda);
  const session = vault.activeSession;
  if (!session) throw new Error('readTabMeter: no active session on vault');
  // VERIFIED: spent + maxAmount are native bigints on ActiveSession (no BN).
  const spent: bigint = session.spent;
  const maxAmount: bigint = session.maxAmount;
  const raw = maxAmount - spent;
  const remaining = raw > 0n ? raw : 0n;
  return { spent, maxAmount, remaining };
}
```

Create `src/tab/openTab.ts`:
```ts
/**
 * openTab — composes the settle_voucher(increment) leg that raises
 * current_outstanding and arms the tab. Returns instructions; does NOT send.
 */
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { buildSettleVoucherInstruction } from '../instructions/index.js';

export interface OpenTabParams {
  vaultPda: PublicKey;
  swigAddress: PublicKey;
  amount: bigint;            // outstanding to arm
  dexterAuthority: PublicKey;
}

export async function openTab(p: OpenTabParams): Promise<TransactionInstruction[]> {
  const ix = buildSettleVoucherInstruction({
    vaultPda: p.vaultPda,
    amount: p.amount,
    increment: true,
    dexterAuthority: p.dexterAuthority,
  } as any);
  return [ix];
}
```

**Implementer note:** confirm `buildSettleVoucherInstruction`'s real param shape (it may take `{ vault, amount, increment, dexterAuthority }` with different names — check `src/instructions/settleVoucher.ts`). The contract is "compose the increment leg, return instructions"; adapt the call. The `readVaultFull` session fields are VERIFIED as `spent` + `maxAmount` (both native `bigint`) — there is NO `currentOutstanding`/`maxRevolvingCapacity` on this reader, so the meter uses `maxAmount` (cap) and `spent`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/tab.readTabMeter.test.ts tests/tab.openTab.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/tab/openTab.ts src/tab/readTabMeter.ts tests/tab.openTab.test.ts tests/tab.readTabMeter.test.ts
git commit -m "feat(sdk): openTab (arm the tab) + readTabMeter (read-only capacity reporter)"
```

### Task 6: Credit verbs — `drawCredit`, `repayCredit`, `seizeCollateral`

**Files:**
- Create: `src/tab/credit.ts`
- Test: `tests/tab.credit.test.ts`

**Context:** the credit instructions are already built + mainnet-proven (`buildDrawCreditInstruction`, `buildRepayCreditInstruction`, `buildSeizeCollateralInstruction` in `src/instructions/credit.ts`). These verbs wrap each with the SignV2 transfer in the same shape as `settleTab`. Whose-swig: draw = FINANCIER swig funds → seller; repay + seize = USER swig funds → financier.

- [ ] **Step 1: Write the failing test**

Create `tests/tab.credit.test.ts`:
```ts
import { describe, test, expect } from 'vitest';
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { drawCredit, repayCredit, seizeCollateral } from '../src/tab/credit.js';

const VAULT = new PublicKey('SysvarC1ock11111111111111111111111111111111');
const FIN_SWIG = new PublicKey('SysvarRent111111111111111111111111111111111');
const USER_SWIG = new PublicKey('So11111111111111111111111111111111111111112');
const MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const DEST = new PublicKey('11111111111111111111111111111111');
const AUTH = new PublicKey('Ed25519SigVerify111111111111111111111111111');
const marker = (b: number) => async (_a: any) =>
  [new TransactionInstruction({ programId: FIN_SWIG, keys: [], data: Buffer.from([b]) })];

describe('credit verbs', () => {
  test('drawCredit composes draw_credit + SignV2 from the FINANCIER swig to seller', async () => {
    let sawSwig: PublicKey | undefined;
    const ixs = await drawCredit({
      connection: {} as any, userVaultPda: VAULT, financierSwig: FIN_SWIG,
      amount: 3_000_000n, recoveryWindowSeconds: 300n, dexterAuthority: AUTH,
      mint: MINT, sellerAta: DEST, feePayer: DEST,
      assembleSignV2: async (a: any) => { sawSwig = a.swigAddress; return marker(0xd)(a); },
    });
    expect(sawSwig!.equals(FIN_SWIG)).toBe(true);           // draw funds from financier
    expect(Array.from(ixs[ixs.length - 1].data)).toEqual([0xd]);
  });

  test('repayCredit composes repay_credit + SignV2 from the USER swig to financier', async () => {
    let sawSwig: PublicKey | undefined;
    await repayCredit({
      connection: {} as any, userVaultPda: VAULT, userSwig: USER_SWIG,
      amount: 1_000_000n, dexterAuthority: AUTH, mint: MINT, financierAta: DEST, feePayer: DEST,
      assembleSignV2: async (a: any) => { sawSwig = a.swigAddress; return marker(0xe)(a); },
    });
    expect(sawSwig!.equals(USER_SWIG)).toBe(true);          // repay funds from user
  });

  test('seizeCollateral composes seize_collateral + SignV2 from the USER swig to financier', async () => {
    let sawSwig: PublicKey | undefined;
    await seizeCollateral({
      connection: {} as any, userVaultPda: VAULT, userSwig: USER_SWIG,
      dexterAuthority: AUTH, mint: MINT, financierAta: DEST, feePayer: DEST,
      seizeAmount: 2_000_000n,
      assembleSignV2: async (a: any) => { sawSwig = a.swigAddress; return marker(0xf)(a); },
    });
    expect(sawSwig!.equals(USER_SWIG)).toBe(true);          // seize funds from user
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tab.credit.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/tab/credit.ts`**

```ts
/**
 * Credit verbs — the tab that can spend PAST the balance. Each wraps a proven,
 * mainnet-tested credit instruction with the SignV2 transfer, same shape as
 * settleTab. Whose-swig: draw = FINANCIER funds → seller; repay + seize = USER
 * funds → financier. Returns instructions; does NOT send.
 */
import { Connection, PublicKey, TransactionInstruction } from '@solana/web3.js';
import {
  buildDrawCreditInstruction,
  buildRepayCreditInstruction,
  buildSeizeCollateralInstruction,
} from '../instructions/index.js';
import { defaultAssembleSignV2, type AssembleSignV2 } from './assembleSignV2.js';

export interface DrawCreditParams {
  connection: Connection;
  userVaultPda: PublicKey;
  financierSwig: PublicKey;       // == vault.standby_backer; funds the draw
  amount: bigint;
  recoveryWindowSeconds: bigint;
  dexterAuthority: PublicKey;
  mint: PublicKey;
  sellerAta: PublicKey;
  feePayer: PublicKey;
  assembleSignV2?: AssembleSignV2;
}

export async function drawCredit(p: DrawCreditParams): Promise<TransactionInstruction[]> {
  const vaultIx = buildDrawCreditInstruction({
    financierSwig: p.financierSwig,
    vaultPda: p.userVaultPda,
    dexterAuthority: p.dexterAuthority,
    amount: p.amount,
    recoveryWindowSeconds: p.recoveryWindowSeconds,
  } as any);
  const assemble = p.assembleSignV2 ?? defaultAssembleSignV2;
  const signV2Ixs = await assemble({
    connection: p.connection,
    swigAddress: p.financierSwig,                 // financier funds
    feePayer: p.feePayer,
    vaultIx,
    transfers: [{ destinationAta: p.sellerAta, amount: p.amount }],
  });
  return [vaultIx, ...signV2Ixs];
}

export interface RepayCreditParams {
  connection: Connection;
  userVaultPda: PublicKey;
  userSwig: PublicKey;            // user funds the repayment
  amount: bigint;
  dexterAuthority: PublicKey;
  mint: PublicKey;
  financierAta: PublicKey;
  feePayer: PublicKey;
  assembleSignV2?: AssembleSignV2;
}

export async function repayCredit(p: RepayCreditParams): Promise<TransactionInstruction[]> {
  const vaultIx = buildRepayCreditInstruction({
    swigAddress: p.userSwig,
    vaultPda: p.userVaultPda,
    dexterAuthority: p.dexterAuthority,
    amount: p.amount,
  } as any);
  const assemble = p.assembleSignV2 ?? defaultAssembleSignV2;
  const signV2Ixs = await assemble({
    connection: p.connection,
    swigAddress: p.userSwig,                       // user funds
    feePayer: p.feePayer,
    vaultIx,
    transfers: [{ destinationAta: p.financierAta, amount: p.amount }],
  });
  return [vaultIx, ...signV2Ixs];
}

export interface SeizeCollateralParams {
  connection: Connection;
  userVaultPda: PublicKey;
  userSwig: PublicKey;            // seizes from user collateral
  dexterAuthority: PublicKey;
  mint: PublicKey;
  financierAta: PublicKey;
  feePayer: PublicKey;
  /** The borrowed amount being seized (the on-chain snapshot the SignV2 transfers). */
  seizeAmount: bigint;
  assembleSignV2?: AssembleSignV2;
}

export async function seizeCollateral(p: SeizeCollateralParams): Promise<TransactionInstruction[]> {
  const vaultIx = buildSeizeCollateralInstruction({
    swigAddress: p.userSwig,
    vaultPda: p.userVaultPda,
    dexterAuthority: p.dexterAuthority,
  } as any);
  const assemble = p.assembleSignV2 ?? defaultAssembleSignV2;
  const signV2Ixs = await assemble({
    connection: p.connection,
    swigAddress: p.userSwig,                       // seize from user
    feePayer: p.feePayer,
    vaultIx,
    transfers: [{ destinationAta: p.financierAta, amount: p.seizeAmount }],
  });
  return [vaultIx, ...signV2Ixs];
}
```

**Implementer note:** the `buildDrawCreditInstruction` / `buildRepayCreditInstruction` / `buildSeizeCollateralInstruction` arg shapes must match `src/instructions/credit.ts` exactly — read that file and align the call sites (param names like `financierSwig`, `swigAddress`, `vaultPda`, `dexterAuthority`). The COMPOSITION and whose-swig (draw=financier, repay/seize=user) are the locked contract.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/tab.credit.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**
```bash
git add src/tab/credit.ts tests/tab.credit.test.ts
git commit -m "feat(sdk): credit verbs (drawCredit/repayCredit/seizeCollateral) in ./tab"
```

### Task 7: `./tab` barrel export + wire the subpath

**Files:**
- Create: `src/tab/index.ts`
- Modify: `package.json`, `tsup.config.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/tab.index.test.ts`:
```ts
import { describe, test, expect } from 'vitest';
import * as tab from '../src/tab/index.js';

describe('./tab barrel', () => {
  test('exposes the full verb surface', () => {
    for (const name of ['openTab', 'settleTab', 'readTabMeter', 'drawCredit', 'repayCredit', 'seizeCollateral']) {
      expect(typeof (tab as any)[name]).toBe('function');
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tab.index.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the barrel + wire the export**

Create `src/tab/index.ts`:
```ts
/**
 * @dexterai/vault/tab — the composed product layer over the buyer-side
 * primitives. Open a tab, stream + settle micro-charges, and (the tab that can
 * spend past the balance) draw/repay/seize credit. Every verb COMPOSES and
 * RETURNS instructions; the caller owns the transaction lifecycle.
 */
export { openTab } from './openTab.js';
export type { OpenTabParams } from './openTab.js';
export { settleTab } from './settleTab.js';
export type { SettleTabParams } from './settleTab.js';
export { readTabMeter } from './readTabMeter.js';
export type { TabMeter } from './readTabMeter.js';
export { drawCredit, repayCredit, seizeCollateral } from './credit.js';
export type { DrawCreditParams, RepayCreditParams, SeizeCollateralParams } from './credit.js';
export { defaultAssembleSignV2 } from './assembleSignV2.js';
export type { AssembleSignV2, AssembleSignV2Args } from './assembleSignV2.js';
export type { TabTransfer } from './types.js';
```

Add `./tab` to `package.json` `exports`:
```jsonc
    "./tab": {
      "types": "./dist/tab/index.d.ts",
      "import": "./dist/tab/index.js",
      "require": "./dist/tab/index.cjs"
    },
```
Add `src/tab/index.ts` to `tsup.config.ts` entries (if entries are explicit).

- [ ] **Step 4: Run test + full suite + typecheck + build**

Run: `npx vitest run tests/tab.index.test.ts && npx tsc --noEmit && npx vitest run && npm run build`
Expected: all green; `dist/tab/index.{js,cjs,d.ts}` emitted.

- [ ] **Step 5: Commit**
```bash
git add src/tab/index.ts package.json tsup.config.ts tests/tab.index.test.ts
git commit -m "feat(sdk): export the ./tab subpath (openTab/settleTab/readTabMeter + credit)"
```

---

## PIECE 3 — README + changelog

### Task 8: Rewrite the README product-first + truthful, bump changelog

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**GTM GATE:** the README's *wording/shape* (product-first framing, the two-sided DAP-SDK story) is a GTM-agent decision per the spec §7. This task makes it TRUTHFUL and drafts the product-first shape; the GTM agent confirms/edits the marketing copy before publish. Do not publish.

- [ ] **Step 1: Fix the verified-stale facts**

In `README.md`, correct every stale claim:
- "version 2" / "all instructions assert version == 2" → the program is **V5**; the SDK targets it.
- "12 discriminators" / "12 Anchor discriminators" → **20** discriminators (verify count in `src/constants/index.ts`).
- "180-byte session message" → **188-byte V2** session message.
- `BrowserPasskeySigner` / "v0.2 work" described as unshipped → `WebAuthnAssertion` **shipped in 0.2.0** (`./signers/browser`).
- Add mention of the credit, LockedClaim, and factoring tiers + the revolving meter (currently absent).

- [ ] **Step 2: Add the product-first hero + `./tab` quick-start (draft for GTM)**

Add, near the top (after the badges, before the parts reference), a product section:
```markdown
## Open a tab for your agent

Your money stays yours — you can see every dollar. You open a tab with a hard
limit, your agent spends against it, and the **chain** enforces the limit. We
couldn't let it overspend even if we wanted to. Don't trust us — check the chain.

```ts
import { openTab, settleTab, readTabMeter } from '@dexterai/vault/tab';

// arm a tab with a chain-enforced cap
const open = await openTab({ vaultPda, swigAddress, amount: 5_000_000n, dexterAuthority });

// settle a streamed micro-charge (composes precompile + settle + transfer)
const settle = await settleTab({
  connection, vaultPda, swigAddress, channelId,
  cumulativeAmount, sequenceNumber, sessionSigner, mint, sellerAta, feePayer,
});

// read remaining capacity (the chain is the real guard)
const meter = await readTabMeter(connection, vaultPda);
```

And the tab that can spend **past** the balance — credit, backed by a financier's
standby capital, non-custodial and un-ruggable (`drawCredit` / `repayCredit` /
`seizeCollateral`, same `./tab` import).

> **Two sides, one standard.** This package is the **buyer** side. The **seller**
> side (verify vouchers, meter, accept payment) lives in `@dexterai/x402/tab/seller`.
> Together they are the Dexter Agent Payments SDK.
```
Then keep the existing "byte-precise primitives" content below it under an
"Under the hood — the primitives" heading (parts reference for power users).

- [ ] **Step 3: Add the changelog entry**

In `CHANGELOG.md`, add a new top entry:
```markdown
## 0.5.0 — 2026-06-07

### Added
- **`@dexterai/vault/tab`** — the composed product layer over the buyer-side primitives. `openTab`, `settleTab` (atomic precompile + settle_tab_voucher + Swig SignV2, with the cumulative-delta freshness-read done internally), `readTabMeter` (read-only capacity reporter — the chain stays authoritative), and the credit verbs `drawCredit` / `repayCredit` / `seizeCollateral`. All compose and return `TransactionInstruction[]` with an injectable `assembleSignV2` (defaults to real Swig); none send. Promoted from the proven facilitator settle loop.
- **`@dexterai/vault/kit`** — single home for the `kitInstructionsToWeb3` / `getRpc` Swig-kit↔web3 bridge (previously duplicated across 8 files). `./factoring` now imports it.

### Fixed
- **Byte-parity test is now a real parity check** — derives each discriminator from `sha256("global:<name>")` instead of comparing constants to copies of themselves.
- **README brought current** — was documenting program v2 / 12 discriminators / 180-byte session; now reflects the V5 program, 20 discriminators, 188-byte V2 session, shipped `WebAuthnAssertion`, and the credit/lockedClaim/factoring tiers.

This is additive; prior consumers continue to work unchanged.
```

- [ ] **Step 4: Verify build + full suite still green**

Run: `npx tsc --noEmit && npx vitest run && npm run build`
Expected: all green.

- [ ] **Step 5: Commit**
```bash
git add README.md CHANGELOG.md
git commit -m "docs(sdk): README product-first + truthful (V5/20/188/credit); changelog 0.5.0"
```

---

## Final verification (after all tasks)

- [ ] `npx tsc --noEmit && npx vitest run && npm run build` all green.
- [ ] `./kit` and `./tab` appear in `package.json` exports and emit to `dist/`.
- [ ] No existing export was renamed, removed, or hidden (grep the diff for deletions in `src/index.ts`, `src/instructions/index.ts`, `src/constants/index.ts`).
- [ ] `./factoring` still works (imports the bridge from `./kit`; its tests pass).
- [ ] Every `./tab` verb returns `TransactionInstruction[]` and none calls send/confirm.
- [ ] NO publish, NO `npm version` run. (0.5.0 is in the changelog text only; the actual version bump + publish is Branch-gated.)
- [ ] Facilitator is UNTOUCHED (cutover is the separate Step B follow-on, not this plan).
- [ ] The GTM-flagged items (credit-inside-`./tab`, README shape, the DAP-SDK two-sided story) are confirmed by the GTM agent before publish.

---

## Notes for the executor

- **The composition + whose-swig is the locked contract; exact builder call-sites adapt to source.** Several tasks say "verify the real signature of `buildXInstruction` and adapt." That is intentional — the builders exist and are proven; the plan pins the *composition* (precompile/vault-ix/SignV2 ordering, the delta math, whose swig funds what) and lets the implementer match the exact param names against `src/instructions/`. This is not a placeholder — it is the correct division between locked design and known-existing detail.
- **Default-real-injectable everywhere.** Every verb's assembler (and settleTab's chain-read) defaults to the real implementation and accepts an injected fake for tests. That is the proven `instantPayout.ts` testability shape.
- **Return instructions, never send.** If any verb is tempted to send/confirm, it is wrong — the SDK gets the recipe, the consumer keeps the kitchen.
- **Additive only.** Nothing renamed/removed/hidden. Four live consumers import primitives by name.
