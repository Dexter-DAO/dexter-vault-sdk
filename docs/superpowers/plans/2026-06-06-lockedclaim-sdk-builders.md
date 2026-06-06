# LockedClaim SDK Builders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the four LockedClaim instruction builders (`lockVoucher`, `settleLockedVoucher`, `transferLockOwnership`, `recoverAbandonedLock`) to `@dexterai/vault` so factoring and credit are drivable from any client — plus a `provePasskey` builder rider for Sign-in-with-Tab groundwork.

**Architecture:** Each builder is a pure function returning a `TransactionInstruction`, mirroring the existing `buildFinalizeWithdrawalInstruction` pattern in `withdraw.ts`. Account ordering MUST match the on-chain Anchor structs exactly (consensus-critical). Discriminators and the `LOCKED_CLAIM_SEED` are added to `constants/index.ts`. No on-chain changes — the program already ships these 5 instructions on mainnet (`Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc`).

**Tech Stack:** TypeScript, `@solana/web3.js` (`TransactionInstruction`, `PublicKey`), Node `Buffer` for Borsh-style encoding, `tsup` build, `vitest` for byte-parity tests.

---

## Reference: the on-chain truth (verified 2026-06-06 against the deployed program)

**Discriminators** are `sha256("global:<ix_name>")[..8]`, cross-checked against `src/idl/dexter_vault.json`. Get the exact bytes from the IDL — DO NOT hand-compute; read them from `src/idl/dexter_vault.json` (each instruction object has a `discriminator: [u8;8]` field).

**Account orders (from `programs/dexter-vault/src/instructions/*.rs`):**

`lock_voucher` (LockVoucherArgs: channel_id [u8;32], cumulative_amount u64, sequence_number u32, voucher_hash [u8;32], maturity_at Option<i64>, holder_recovery_at Option<i64>):
```
0 vault                (writable)
1 vault_usdc_ata       (readonly)
2 swig                 (readonly, == vault.swig_address)
3 swig_wallet_address  (readonly, PDA: [SWIG_WALLET_ADDRESS_SEED, swig], swig program)
4 claim                (writable, PDA: [LOCKED_CLAIM_SEED, vault, voucher_hash], vault program)
5 seller_holder        (signer)
6 dexter_authority     (signer)
7 payer                (signer, writable)
8 system_program       (readonly)
9 instructions_sysvar  (readonly)
```

`settle_locked_voucher` (SettleLockedVoucherArgs: empty):
```
0 swig                 (readonly)
1 swig_wallet_address  (readonly, PDA)
2 claim                (writable)
3 vault                (writable)
4 holder               (signer)
5 dexter_authority     (signer)
```

`transfer_lock_ownership` (TransferLockOwnershipArgs: new_holder Pubkey):
```
0 claim                (writable)
1 current_holder       (signer)
```

`recover_abandoned_lock` (RecoverAbandonedLockArgs: client_data_json Vec<u8>, authenticator_data Vec<u8>):
```
0 claim                (writable)
1 vault                (writable)
2 instructions_sysvar  (readonly)
```

**Existing constants in `src/constants/index.ts`:** `DEXTER_VAULT_PROGRAM_ID`, `SWIG_PROGRAM_ID`, `INSTRUCTIONS_SYSVAR_ID`, `DISCRIMINATORS` (map), `USDC_MAINNET`. Already-present discriminators include `prove_passkey`. **Missing:** the 4 LockedClaim discriminators, `LOCKED_CLAIM_SEED`, `SWIG_WALLET_ADDRESS_SEED` (verify — may exist).

**Existing helpers to reuse (do NOT refactor — match the per-file convention):**
- `deriveSwigWalletAddress(swigAddress)` exported from `src/instructions/withdraw.ts`.
- `encodeU64(bigint)`, `encodeBool(bool)`, `encodeBytesVec(Uint8Array)` — defined per-file in `settleVoucher.ts` / `setSwig.ts`. Copy the same local helpers into the new file (the codebase duplicates these intentionally).

---

## File Structure

- **Create:** `src/instructions/lockedClaim.ts` — all 4 LockedClaim builders + their param interfaces + the local encoding helpers (incl. a new `encodeOptionI64`). One file: these four instructions are one cohesive surface (the claim lifecycle) and change together.
- **Create:** `src/instructions/provePasskey.ts` — ALREADY EXISTS; verify it exports a builder. If a builder is missing, add `buildProvePasskeyInstruction` (the SIWT rider). (Confirm first; it may already be complete.)
- **Modify:** `src/constants/index.ts` — add 4 discriminators + `LOCKED_CLAIM_SEED`.
- **Modify:** `src/instructions/index.ts` — re-export the 4 new builders.
- **Modify:** `src/index.ts` — ensure the new builders are surfaced on the package root (check how existing builders are exported).
- **Test:** `tests/lockedClaim.byte-parity.test.ts` — byte-parity snapshots (discriminator + account count + key order) for all 4.

---

## Task 1: Add LockedClaim discriminators + seed to constants

**Files:**
- Modify: `src/constants/index.ts`
- Reference: `src/idl/dexter_vault.json` (read the discriminator bytes from here)

- [ ] **Step 1: Read the four discriminators from the IDL**

Run: `node -e "const idl=require('./src/idl/dexter_vault.json'); for (const n of ['lock_voucher','settle_locked_voucher','transfer_lock_ownership','recover_abandoned_lock']){const ix=idl.instructions.find(i=>i.name===n||i.name===n.replace(/_(.)/g,(_,c)=>c.toUpperCase())); console.log(n, ix && ix.discriminator);}"`
Expected: four arrays of 8 numbers each. Record them. (If the IDL uses camelCase names, the find handles both.)

- [ ] **Step 2: Verify SWIG_WALLET_ADDRESS_SEED + LOCKED_CLAIM_SEED presence**

Run: `grep -nE "SWIG_WALLET_ADDRESS_SEED|LOCKED_CLAIM_SEED" src/constants/index.ts`
Expected: note which exist. `LOCKED_CLAIM_SEED` is expected MISSING; `SWIG_WALLET_ADDRESS_SEED` may exist (used by `deriveSwigWalletAddress`).

- [ ] **Step 3: Get the on-chain seed byte values**

Run: `grep -rnE "LOCKED_CLAIM_SEED|SWIG_WALLET_ADDRESS_SEED" ../dexter-vault/programs/dexter-vault/src/constants.rs`
Expected: the literal byte strings, e.g. `pub const LOCKED_CLAIM_SEED: &[u8] = b"locked-claim";`. Use the EXACT string.

- [ ] **Step 4: Add the discriminators + seed to the DISCRIMINATORS map and exports**

In `src/constants/index.ts`, inside the `DISCRIMINATORS` object, add (use the real bytes from Step 1):

```typescript
  lock_voucher:            Uint8Array.from([/* bytes from IDL */]),
  settle_locked_voucher:   Uint8Array.from([/* bytes from IDL */]),
  transfer_lock_ownership: Uint8Array.from([/* bytes from IDL */]),
  recover_abandoned_lock:  Uint8Array.from([/* bytes from IDL */]),
```

And add the seed export (use the exact string from Step 3; example shown):

```typescript
// LockedClaim PDA seed — matches programs/dexter-vault/src/constants.rs
export const LOCKED_CLAIM_SEED = Buffer.from('locked-claim');
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0, no errors.

- [ ] **Step 6: Commit**

```bash
git add src/constants/index.ts
git commit -m "feat(vault-sdk): add LockedClaim discriminators + LOCKED_CLAIM_SEED"
```

---

## Task 2: Build `transferLockOwnership` (simplest — 2 accounts, validates the pattern)

**Files:**
- Create: `src/instructions/lockedClaim.ts`
- Test: `tests/lockedClaim.byte-parity.test.ts`

- [ ] **Step 1: Write the failing byte-parity test**

Create `tests/lockedClaim.byte-parity.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { buildTransferLockOwnershipInstruction } from '../src/instructions/lockedClaim.js';
import { DEXTER_VAULT_PROGRAM_ID, DISCRIMINATORS } from '../src/constants/index.js';

const CLAIM = new PublicKey('11111111111111111111111111111111');
const HOLDER = new PublicKey('So11111111111111111111111111111111111111112');
const NEW_HOLDER = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

describe('transferLockOwnership', () => {
  it('emits 2 accounts in canonical order with the right discriminator', () => {
    const ix = buildTransferLockOwnershipInstruction({
      claimPda: CLAIM,
      currentHolder: HOLDER,
      newHolder: NEW_HOLDER,
    });
    expect(ix.programId.equals(DEXTER_VAULT_PROGRAM_ID)).toBe(true);
    expect(ix.keys.length).toBe(2);
    expect(ix.keys[0].pubkey.equals(CLAIM)).toBe(true);
    expect(ix.keys[0].isWritable).toBe(true);
    expect(ix.keys[1].pubkey.equals(HOLDER)).toBe(true);
    expect(ix.keys[1].isSigner).toBe(true);
    // discriminator (8) + new_holder pubkey (32) = 40 bytes
    expect(ix.data.length).toBe(40);
    expect(Buffer.from(ix.data.subarray(0, 8))).toEqual(
      Buffer.from(DISCRIMINATORS.transfer_lock_ownership),
    );
    expect(Buffer.from(ix.data.subarray(8, 40))).toEqual(NEW_HOLDER.toBuffer());
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/lockedClaim.byte-parity.test.ts`
Expected: FAIL — cannot resolve `../src/instructions/lockedClaim.js` (file does not exist).

- [ ] **Step 3: Create the file with the transfer builder**

Create `src/instructions/lockedClaim.ts`:

```typescript
/**
 * LockedClaim instruction builders — the claim lifecycle.
 * Mirrors the on-chain Anchor structs in
 * programs/dexter-vault/src/instructions/{lock_voucher,settle_locked_voucher,
 * transfer_lock_ownership,recover_abandoned_lock}.rs. Account ordering is
 * consensus-critical and MUST match the program exactly.
 */
import { PublicKey, TransactionInstruction, SystemProgram } from '@solana/web3.js';
import {
  DEXTER_VAULT_PROGRAM_ID,
  DISCRIMINATORS,
  INSTRUCTIONS_SYSVAR_ID,
} from '../constants/index.js';

// ── transfer_lock_ownership ────────────────────────────────────────────────

export interface TransferLockOwnershipParams {
  claimPda: PublicKey;
  currentHolder: PublicKey;
  newHolder: PublicKey;
}

/**
 * Account order MUST match the on-chain struct:
 *   [0] claim          (writable)
 *   [1] current_holder (signer)
 * Data: discriminator || new_holder (32-byte pubkey).
 */
export function buildTransferLockOwnershipInstruction(
  p: TransferLockOwnershipParams,
): TransactionInstruction {
  const data = Buffer.concat([
    Buffer.from(DISCRIMINATORS.transfer_lock_ownership),
    p.newHolder.toBuffer(),
  ]);
  return new TransactionInstruction({
    programId: DEXTER_VAULT_PROGRAM_ID,
    keys: [
      { pubkey: p.claimPda, isSigner: false, isWritable: true },
      { pubkey: p.currentHolder, isSigner: true, isWritable: false },
    ],
    data,
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/lockedClaim.byte-parity.test.ts`
Expected: PASS (1 passing).

- [ ] **Step 5: Commit**

```bash
git add src/instructions/lockedClaim.ts tests/lockedClaim.byte-parity.test.ts
git commit -m "feat(vault-sdk): transferLockOwnership builder + byte-parity test"
```

---

## Task 3: Build `recoverAbandonedLock` (3 accounts, 2 byte-vec args)

**Files:**
- Modify: `src/instructions/lockedClaim.ts`
- Test: `tests/lockedClaim.byte-parity.test.ts`

- [ ] **Step 1: Write the failing test (append to the test file)**

Append to `tests/lockedClaim.byte-parity.test.ts`:

```typescript
import { buildRecoverAbandonedLockInstruction } from '../src/instructions/lockedClaim.js';

const VAULT = new PublicKey('SysvarС1ock11111111111111111111111111111111'.replace('С','C'));

describe('recoverAbandonedLock', () => {
  it('emits 3 accounts and length-prefixed byte-vec args', () => {
    const clientDataJSON = new Uint8Array([1, 2, 3]);
    const authenticatorData = new Uint8Array([4, 5, 6, 7]);
    const ix = buildRecoverAbandonedLockInstruction({
      claimPda: CLAIM,
      vaultPda: VAULT,
      clientDataJSON,
      authenticatorData,
    });
    expect(ix.keys.length).toBe(3);
    expect(ix.keys[0].pubkey.equals(CLAIM)).toBe(true);
    expect(ix.keys[0].isWritable).toBe(true);
    expect(ix.keys[1].pubkey.equals(VAULT)).toBe(true);
    expect(ix.keys[1].isWritable).toBe(true);
    expect(ix.keys[2].isWritable).toBe(false); // instructions_sysvar
    // disc(8) + len(4)+3 + len(4)+4 = 8 + 7 + 8 = 23
    expect(ix.data.length).toBe(23);
    expect(Buffer.from(ix.data.subarray(0, 8))).toEqual(
      Buffer.from(DISCRIMINATORS.recover_abandoned_lock),
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/lockedClaim.byte-parity.test.ts -t recoverAbandonedLock`
Expected: FAIL — `buildRecoverAbandonedLockInstruction` is not exported.

- [ ] **Step 3: Add the encoding helper + builder**

Append to `src/instructions/lockedClaim.ts`:

```typescript
// ── local encoding helpers (per-file convention, matches settleVoucher.ts) ──

function encodeBytesVec(buf: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(buf.length, 0);
  return Buffer.concat([len, Buffer.from(buf)]);
}

// ── recover_abandoned_lock ─────────────────────────────────────────────────

export interface RecoverAbandonedLockParams {
  claimPda: PublicKey;
  vaultPda: PublicKey;
  clientDataJSON: Uint8Array;
  authenticatorData: Uint8Array;
}

/**
 * Account order MUST match the on-chain struct:
 *   [0] claim               (writable)
 *   [1] vault               (writable)
 *   [2] instructions_sysvar (readonly)
 * Data: discriminator || vec(client_data_json) || vec(authenticator_data).
 */
export function buildRecoverAbandonedLockInstruction(
  p: RecoverAbandonedLockParams,
): TransactionInstruction {
  const data = Buffer.concat([
    Buffer.from(DISCRIMINATORS.recover_abandoned_lock),
    encodeBytesVec(p.clientDataJSON),
    encodeBytesVec(p.authenticatorData),
  ]);
  return new TransactionInstruction({
    programId: DEXTER_VAULT_PROGRAM_ID,
    keys: [
      { pubkey: p.claimPda, isSigner: false, isWritable: true },
      { pubkey: p.vaultPda, isSigner: false, isWritable: true },
      { pubkey: INSTRUCTIONS_SYSVAR_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/lockedClaim.byte-parity.test.ts`
Expected: PASS (2 describe blocks passing).

- [ ] **Step 5: Commit**

```bash
git add src/instructions/lockedClaim.ts tests/lockedClaim.byte-parity.test.ts
git commit -m "feat(vault-sdk): recoverAbandonedLock builder + byte-parity test"
```

---

## Task 4: Build `settleLockedVoucher` (6 accounts, empty args, swig-wallet PDA)

**Files:**
- Modify: `src/instructions/lockedClaim.ts`
- Test: `tests/lockedClaim.byte-parity.test.ts`

- [ ] **Step 1: Write the failing test (append)**

```typescript
import { buildSettleLockedVoucherInstruction } from '../src/instructions/lockedClaim.js';
import { deriveSwigWalletAddress } from '../src/instructions/withdraw.js';

const SWIG = new PublicKey('SwigGdF8b9V2D3J4k5L6m7N8p9Q1r2S3t4U5v6W7x8Y');

describe('settleLockedVoucher', () => {
  it('emits 6 accounts in canonical order, empty args (disc only)', () => {
    const ix = buildSettleLockedVoucherInstruction({
      swigAddress: SWIG,
      claimPda: CLAIM,
      vaultPda: VAULT,
      holder: HOLDER,
      dexterAuthority: NEW_HOLDER, // reuse a valid pubkey as the authority
    });
    expect(ix.keys.length).toBe(6);
    expect(ix.keys[0].pubkey.equals(SWIG)).toBe(true);
    expect(ix.keys[1].pubkey.equals(deriveSwigWalletAddress(SWIG))).toBe(true);
    expect(ix.keys[2].pubkey.equals(CLAIM)).toBe(true);
    expect(ix.keys[2].isWritable).toBe(true);
    expect(ix.keys[3].pubkey.equals(VAULT)).toBe(true);
    expect(ix.keys[3].isWritable).toBe(true);
    expect(ix.keys[4].isSigner).toBe(true); // holder
    expect(ix.keys[5].isSigner).toBe(true); // dexter_authority
    expect(ix.data.length).toBe(8); // discriminator only (empty args)
  });
});
```

NOTE: if `SWIG` is not a valid base58 string, replace with any valid 32-byte pubkey literal (e.g. reuse `NEW_HOLDER`); the test only checks ordering/derivation, not real swig state.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/lockedClaim.byte-parity.test.ts -t settleLockedVoucher`
Expected: FAIL — `buildSettleLockedVoucherInstruction` not exported.

- [ ] **Step 3: Add the builder (imports `deriveSwigWalletAddress`)**

At the top of `src/instructions/lockedClaim.ts`, add to imports:
```typescript
import { deriveSwigWalletAddress } from './withdraw.js';
```

Append the builder:

```typescript
// ── settle_locked_voucher ──────────────────────────────────────────────────

export interface SettleLockedVoucherParams {
  swigAddress: PublicKey;
  claimPda: PublicKey;
  vaultPda: PublicKey;
  holder: PublicKey;
  dexterAuthority: PublicKey;
}

/**
 * Account order MUST match the on-chain struct:
 *   [0] swig                (readonly, == vault.swig_address)
 *   [1] swig_wallet_address (readonly, PDA derived from swig)
 *   [2] claim               (writable)
 *   [3] vault               (writable)
 *   [4] holder              (signer — the current claim holder collecting)
 *   [5] dexter_authority    (signer)
 * Data: discriminator only (SettleLockedVoucherArgs is empty).
 */
export function buildSettleLockedVoucherInstruction(
  p: SettleLockedVoucherParams,
): TransactionInstruction {
  const data = Buffer.from(DISCRIMINATORS.settle_locked_voucher);
  const swigWalletAddress = deriveSwigWalletAddress(p.swigAddress);
  return new TransactionInstruction({
    programId: DEXTER_VAULT_PROGRAM_ID,
    keys: [
      { pubkey: p.swigAddress, isSigner: false, isWritable: false },
      { pubkey: swigWalletAddress, isSigner: false, isWritable: false },
      { pubkey: p.claimPda, isSigner: false, isWritable: true },
      { pubkey: p.vaultPda, isSigner: false, isWritable: true },
      { pubkey: p.holder, isSigner: true, isWritable: false },
      { pubkey: p.dexterAuthority, isSigner: true, isWritable: false },
    ],
    data,
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/lockedClaim.byte-parity.test.ts`
Expected: PASS (3 describe blocks).

- [ ] **Step 5: Commit**

```bash
git add src/instructions/lockedClaim.ts tests/lockedClaim.byte-parity.test.ts
git commit -m "feat(vault-sdk): settleLockedVoucher builder + byte-parity test"
```

---

## Task 5: Build `lockVoucher` (10 accounts, the complex one — claim PDA + Option<i64> args)

**Files:**
- Modify: `src/instructions/lockedClaim.ts`
- Test: `tests/lockedClaim.byte-parity.test.ts`

- [ ] **Step 1: Write the failing test (append)**

```typescript
import { buildLockVoucherInstruction, deriveLockedClaimPda } from '../src/instructions/lockedClaim.js';

const USDC_ATA = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const PAYER = new PublicKey('So11111111111111111111111111111111111111112');

describe('lockVoucher', () => {
  it('emits 10 accounts in canonical order with the claim PDA derived', () => {
    const voucherHash = new Uint8Array(32).fill(9);
    const channelId = new Uint8Array(32).fill(1);
    const ix = buildLockVoucherInstruction({
      vaultPda: VAULT,
      vaultUsdcAta: USDC_ATA,
      swigAddress: SWIG,
      sellerHolder: HOLDER,
      dexterAuthority: NEW_HOLDER,
      payer: PAYER,
      channelId,
      cumulativeAmount: 1_000_000n,
      sequenceNumber: 1,
      voucherHash,
      maturityAt: null,
      holderRecoveryAt: 7_776_000n, // ~90 days as a placeholder i64
    });
    expect(ix.keys.length).toBe(10);
    const expectedClaim = deriveLockedClaimPda(VAULT, voucherHash);
    expect(ix.keys[0].pubkey.equals(VAULT)).toBe(true);
    expect(ix.keys[0].isWritable).toBe(true);
    expect(ix.keys[1].pubkey.equals(USDC_ATA)).toBe(true);
    expect(ix.keys[2].pubkey.equals(SWIG)).toBe(true);
    expect(ix.keys[3].pubkey.equals(deriveSwigWalletAddress(SWIG))).toBe(true);
    expect(ix.keys[4].pubkey.equals(expectedClaim)).toBe(true);
    expect(ix.keys[4].isWritable).toBe(true);
    expect(ix.keys[5].isSigner).toBe(true); // seller_holder
    expect(ix.keys[6].isSigner).toBe(true); // dexter_authority
    expect(ix.keys[7].isSigner).toBe(true); // payer
    expect(ix.keys[7].isWritable).toBe(true);
    expect(ix.keys[8].pubkey.equals(SystemProgram.programId)).toBe(true);
    expect(ix.keys[9].isWritable).toBe(false); // instructions_sysvar
    // disc(8)+channel(32)+cum(8)+seq(4)+hash(32)+opt_i64(maturity:1)+opt_i64(recovery:1+8)
    expect(ix.data.length).toBe(8 + 32 + 8 + 4 + 32 + 1 + 9);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/lockedClaim.byte-parity.test.ts -t lockVoucher`
Expected: FAIL — `buildLockVoucherInstruction` / `deriveLockedClaimPda` not exported.

- [ ] **Step 3: Add helpers (encodeU64, encodeU32, encodeOptionI64), PDA derivation, and the builder**

At top of `src/instructions/lockedClaim.ts`, add to imports (only `LOCKED_CLAIM_SEED` — the swig-wallet PDA is derived via `deriveSwigWalletAddress`, so `SWIG_PROGRAM_ID` is NOT needed here; importing it unused would fail strict tsc):
```typescript
import { LOCKED_CLAIM_SEED } from '../constants/index.js';
```

Append helpers + builder:

```typescript
function encodeU64(value: bigint): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(value, 0);
  return out;
}

function encodeU32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value, 0);
  return out;
}

/** Borsh Option<i64>: 0x00 for None, 0x01 || i64-LE for Some. */
function encodeOptionI64(value: bigint | null): Buffer {
  if (value === null) return Buffer.from([0]);
  const out = Buffer.alloc(9);
  out.writeUInt8(1, 0);
  out.writeBigInt64LE(value, 1);
  return out;
}

/** LockedClaim PDA: [LOCKED_CLAIM_SEED, vault, voucher_hash] under the vault program. */
export function deriveLockedClaimPda(vaultPda: PublicKey, voucherHash: Uint8Array): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [LOCKED_CLAIM_SEED, vaultPda.toBuffer(), Buffer.from(voucherHash)],
    DEXTER_VAULT_PROGRAM_ID,
  );
  return pda;
}

// ── lock_voucher ───────────────────────────────────────────────────────────

export interface LockVoucherParams {
  vaultPda: PublicKey;
  vaultUsdcAta: PublicKey;
  swigAddress: PublicKey;
  sellerHolder: PublicKey;
  dexterAuthority: PublicKey;
  payer: PublicKey;
  channelId: Uint8Array;       // 32 bytes
  cumulativeAmount: bigint;
  sequenceNumber: number;
  voucherHash: Uint8Array;     // 32 bytes
  maturityAt: bigint | null;
  holderRecoveryAt: bigint | null;
}

/**
 * Account order MUST match the on-chain struct:
 *   [0] vault               (writable)
 *   [1] vault_usdc_ata      (readonly)
 *   [2] swig                (readonly)
 *   [3] swig_wallet_address (readonly, PDA)
 *   [4] claim               (writable, PDA [LOCKED_CLAIM_SEED, vault, voucher_hash])
 *   [5] seller_holder       (signer)
 *   [6] dexter_authority    (signer)
 *   [7] payer               (signer, writable)
 *   [8] system_program      (readonly)
 *   [9] instructions_sysvar (readonly)
 * Data: disc || channel_id(32) || cumulative(u64) || sequence(u32)
 *       || voucher_hash(32) || option_i64(maturity_at) || option_i64(holder_recovery_at)
 */
export function buildLockVoucherInstruction(p: LockVoucherParams): TransactionInstruction {
  const data = Buffer.concat([
    Buffer.from(DISCRIMINATORS.lock_voucher),
    Buffer.from(p.channelId),
    encodeU64(p.cumulativeAmount),
    encodeU32(p.sequenceNumber),
    Buffer.from(p.voucherHash),
    encodeOptionI64(p.maturityAt),
    encodeOptionI64(p.holderRecoveryAt),
  ]);
  const swigWalletAddress = deriveSwigWalletAddress(p.swigAddress);
  const claimPda = deriveLockedClaimPda(p.vaultPda, p.voucherHash);
  return new TransactionInstruction({
    programId: DEXTER_VAULT_PROGRAM_ID,
    keys: [
      { pubkey: p.vaultPda, isSigner: false, isWritable: true },
      { pubkey: p.vaultUsdcAta, isSigner: false, isWritable: false },
      { pubkey: p.swigAddress, isSigner: false, isWritable: false },
      { pubkey: swigWalletAddress, isSigner: false, isWritable: false },
      { pubkey: claimPda, isSigner: false, isWritable: true },
      { pubkey: p.sellerHolder, isSigner: true, isWritable: false },
      { pubkey: p.dexterAuthority, isSigner: true, isWritable: false },
      { pubkey: p.payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: INSTRUCTIONS_SYSVAR_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/lockedClaim.byte-parity.test.ts`
Expected: PASS (4 describe blocks, all passing).

- [ ] **Step 5: Commit**

```bash
git add src/instructions/lockedClaim.ts tests/lockedClaim.byte-parity.test.ts
git commit -m "feat(vault-sdk): lockVoucher builder + claim PDA derivation + byte-parity test"
```

---

## Task 6: Export the new builders from the package root

**Files:**
- Modify: `src/instructions/index.ts`
- Modify: `src/index.ts` (verify how the root surfaces instruction builders)

- [ ] **Step 1: Check how existing builders are re-exported**

Run: `grep -nE "withdraw|registerSession|settleVoucher" src/instructions/index.ts src/index.ts`
Expected: see the existing `export ... from './withdraw.js'` style; match it.

- [ ] **Step 2: Add the re-export**

In `src/instructions/index.ts`, add (match the existing export style — `export *` or named):

```typescript
export {
  buildLockVoucherInstruction,
  buildSettleLockedVoucherInstruction,
  buildTransferLockOwnershipInstruction,
  buildRecoverAbandonedLockInstruction,
  deriveLockedClaimPda,
} from './lockedClaim.js';
```

- [ ] **Step 3: Verify the root package surfaces them**

Run: `npx tsc --noEmit && npm run build`
Expected: build succeeds. Then:
Run: `node -e "const m=require('./dist/instructions/index.cjs'); console.log(['buildLockVoucherInstruction','buildSettleLockedVoucherInstruction','buildTransferLockOwnershipInstruction','buildRecoverAbandonedLockInstruction'].map(k=>k+':'+(typeof m[k])).join(' '))"`
Expected: all four print `:function`.

- [ ] **Step 4: Run the full test suite (regression check)**

Run: `npx vitest run`
Expected: all tests pass — the new byte-parity tests plus the pre-existing ones (register/finalize byte-parity, etc.).

- [ ] **Step 5: Commit**

```bash
git add src/instructions/index.ts src/index.ts
git commit -m "feat(vault-sdk): export LockedClaim builders from package root"
```

---

## Task 7: provePasskey builder rider (Sign-in-with-Tab groundwork — ONLY if near-free)

**Files:**
- Verify/Modify: `src/instructions/provePasskey.ts`

- [ ] **Step 1: Check whether a provePasskey builder already exists**

Run: `grep -nE "export function buildProvePasskey|export const buildProvePasskey" src/instructions/provePasskey.ts`
Expected: if it EXISTS and is exported → this task is ALREADY DONE; verify it's re-exported (grep `provePasskey` in `src/instructions/index.ts`), add the export if missing, commit, and STOP. If it does NOT exist → proceed to Step 2.

- [ ] **Step 2: (only if missing) Read the on-chain prove_passkey account list**

Run: `awk '/#\[derive\(Accounts\)\]/{cap=1} cap{print} cap&&/^}/{exit}' ../dexter-vault/programs/dexter-vault/src/instructions/prove_passkey.rs | grep -nE 'pub [a-z_]+:|address|signer'`
Expected: the account order. Record it. (Args: `prove_passkey` signs `"siwx_login" || challenge`; ProvePasskeyArgs holds client_data_json + authenticator_data — confirm by reading the Args struct.)

- [ ] **Step 3: (only if missing) Add the builder mirroring the existing pattern**

Follow the exact shape of `buildFinalizeWithdrawalInstruction` (discriminator from `DISCRIMINATORS.prove_passkey`, which already exists, + `encodeBytesVec` args + the account order from Step 2). Write a byte-parity test in the same file as the others.

- [ ] **Step 4: Typecheck + test + commit**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS.

```bash
git add src/instructions/provePasskey.ts src/instructions/index.ts tests/lockedClaim.byte-parity.test.ts
git commit -m "feat(vault-sdk): provePasskey builder (Sign-in-with-Tab groundwork)"
```

**Scope guard:** This task is the ONLY Sign-in-with-Tab work in this sprint. The verifier helper, button, and handshake spec are explicitly OUT (see specs/2026-06-06-sign-in-with-tab-QUEUED.md). If the builder already exists, this whole task collapses to a 2-minute verification.

---

## Final verification (after all tasks)

- [ ] Run `npx vitest run` — all byte-parity tests green.
- [ ] Run `npm run build` — clean.
- [ ] Confirm NO version bump and NO `npm publish` in this plan — publishing is a separate, Branch-gated step. This plan lands SOURCE only.
- [ ] The deployed program is unchanged — these are client builders for instructions already on mainnet. No mainnet test required for byte-parity (the parity tests + the program's own mainnet tests already prove the account lists).

---

## Notes for the executor

- **Account ordering is consensus-critical.** Every builder's `keys` array MUST match the on-chain Anchor struct order exactly. The byte-parity tests assert order, writability, and signer flags — do not weaken them.
- **Discriminators come from the IDL, not hand-computation.** Read `src/idl/dexter_vault.json`.
- **Do NOT refactor the duplicated encoding helpers** into a shared module — the codebase intentionally duplicates `encodeU64`/`encodeBytesVec` per file. Match the convention.
- **Do NOT publish.** This plan lands source + tests only. The npm publish and any version bump are Branch-gated and out of scope.
- **This unblocks** the Factoring plan (needs `settleLockedVoucher` + a discount/fee layer) and the Credit-L2 plan (needs the full claim lifecycle + the new standby-pool instructions, which are a separate on-chain plan).
