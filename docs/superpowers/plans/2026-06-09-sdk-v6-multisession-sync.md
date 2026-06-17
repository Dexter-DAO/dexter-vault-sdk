# SDK V6 Multi-Session Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring `@dexterai/vault` from V5-shaped (single inline session) to V6 (per-counterparty `SessionAccount` PDAs) so every builder emits the account lists + args the live program (`Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc`, deployed V6, byte-verified) actually requires — then prove it end-to-end on mainnet with SDK-built transactions only.

**Architecture:** A new `src/session/` module owns the V6 session primitives (PDA derivation, account decode, liveness, sibling discovery via getProgramAccounts, confirm-visibility wait). The five affected instruction builders (`register_session_key`, `revoke_session_key`, `settle_tab_voucher`, `settle_voucher`, `lock_voucher`) get their V6 account lists + arg tails. The vault reader drops the now-nonexistent `active_session` decode (which would silently mis-decode V6 bytes) and gains `liveSessionCount`. The tab layer re-points its session reads at the PDA. Two migration builders are added. Everything is locked by byte-parity unit tests against the V6 IDL, then a live mainnet proof script drives the full lifecycle through SDK builders alone.

**Tech Stack:** TypeScript, @solana/web3.js, tsup, vitest 4. Live proof runs in the dexter-vault repo's ts-mocha harness (it owns the passkey/secp256r1 apparatus).

**Versioning:** This is a BREAKING release → `0.8.0`. SDK 0.8.x targets V6 vaults ONLY (the deployed program only admits V6 on session paths anyway).

---

## Verified ground truth (read this before any task)

Every fact below was verified byte-for-byte against `dexter-vault` branch `feat/vault-v6-multisession` source + the freshly built IDL (`target/idl/dexter_vault.json`, 28 instructions) on 2026-06-09. Do not re-derive; do not trust memory over this section.

### SessionAccount byte layout (8-byte Anchor discriminator + 154 = 162 bytes total)

```
offset  len  field
0       8    Anchor account discriminator = [74, 34, 65, 133, 96, 163, 80, 69]
8       1    version u8            (0 = never-touched/cleared; 1 = live-written)
9       1    bump u8
10      32   vault Pubkey
42      32   session.session_pubkey [u8;32]
74      8    session.max_amount u64 LE
82      8    session.expires_at i64 LE
90      32   session.allowed_counterparty Pubkey
122     4    session.nonce u32 LE
126     8    session.spent u64 LE
134     8    session.current_outstanding u64 LE
142     8    session.max_revolving_capacity u64 LE
150     8    session.crystallized_cumulative u64 LE
158     4    session.last_locked_sequence u32 LE
TOTAL   162
```

PDA: `seeds = [b"session", vault, allowed_counterparty]` under the vault program.

**`version` is a PROGRAM field, not the Anchor discriminator.** Anchor writes the discriminator during `init_if_needed` BEFORE the handler runs, so a freshly-inited-but-handler-reverted account has a valid discriminator and `version == 0`. `version == 0` is the authoritative "no live session" signal. Liveness = `version === 1 && expires_at > now`.

### V6 Vault layout change (why the old reader silently corrupts)

V5: `... dexter_authority(32) | active_session Option tag(1) + body(121 if Some) | outstanding_locked_amount ...`
V6: `... dexter_authority(32) | live_session_count u8(1) | outstanding_locked_amount ...`

The old `readVaultFull` reads the byte after `dexter_authority` as an Option tag. On a V6 vault with ≥1 live session that byte is `live_session_count ≥ 1`, so the reader "finds" a session and decodes 92 bytes of locked-claim odometers as session fields. **Silent corruption, not an error.** This is why the reader rewrite is mandatory, not cosmetic.

### The register sibling contract (the security core — program source verified)

`register_session_key` accounts, EXACT order:
```
0 vault                (writable)
1 vault_usdc_ata       (readonly)   — overcommit gate reads .amount; owner cross-checked vs swig_wallet_address
2 swig                 (readonly)   — address = vault.swig_address
3 swig_wallet_address  (readonly)   — PDA [b"swig-wallet-address", swig] under SWIG program
4 instructions_sysvar  (readonly)   — secp256r1 precompile MUST be the immediately-prior ix
5 session              (writable)   — init_if_needed PDA [b"session", vault, allowed_counterparty]
6 payer                (signer, writable)
7 system_program       (readonly)
+ remaining_accounts: every OTHER SessionAccount sibling of this vault with version != 0
  (live AND expired-unswept), STRICT ASCENDING by raw 32-byte pubkey, target excluded.
```

Gate facts (from `register_session_key.rs` handler, steps C(i)–(vii)):
- Strict ascending `>` (dedup + order in one check) → `SessionAccountsNotSorted`.
- Target must not appear → `SessionAccountMisderived`.
- Each sibling: owner+discriminator (`SessionAccountForeign`), vault-bound, PDA re-derive via stored bump (`SessionAccountMisderived`).
- Live (`expires_at > now`): summed + counted. Expired: **swept** (cleared on-chain) — **requires the account be writable** → `SessionAccountNotWritable` if not.
- Completeness: `live_counted + swept == live_session_count - (is_new ? 0 : 1)` where `is_new` = target PDA `version == 0` → `IncompleteSessionSet`.
- Overcommit: `sibling_live_sum + new max_amount + outstanding_locked_amount <= vault_usdc_ata.amount` → `SessionWouldOvercommitVault`.

**SDK policy decision (do-more-than-the-handoff, locked):** mark ALL siblings writable. The dexter-vault test helper marks only fetch-time-expired siblings writable, which carries a race: a sibling live at fetch but expired at execution gets partitioned as expired by the gate, which then demands writability → revert. All-writable deletes the race; cost is only extra write locks on program-owned PDAs the program may legitimately mutate (the sweep). Also: **fetch siblings fresh immediately before building/sending** — a stale list double-counts a since-swept sibling and fails completeness.

**Sibling set definition:** pass `version != 0` accounts ONLY. Cleared accounts (`version == 0`, from revoke or a prior sweep) must NOT be passed — `live_session_count` doesn't count them, so including one breaks completeness.

### Instruction account lists + Borsh arg tails (all source-verified)

`revoke_session_key`: accounts `[vault(w), session(w), instructions_sysvar(r)]`; args Borsh order: `allowed_counterparty: Pubkey` FIRST, then `client_data_json: Vec<u8>`, `authenticator_data: Vec<u8>`. The 128-byte revoke message embeds the session_pubkey **read from the session PDA on-chain** — so the caller must fetch the live session's pubkey to build the signable message.

`settle_tab_voucher`: accounts `[swig(r), swig_wallet_address(r), vault(w), session(w), dexter_authority(s), instructions_sysvar(r)]` — session inserted at index 3. Args: `channel_id[32], cumulative_amount u64, sequence_number u32, allowed_counterparty Pubkey` (counterparty APPENDED LAST). The 44-byte voucher message layout is UNCHANGED.

`settle_voucher`: accounts `[vault(w), dexter_authority(s), session(OPTIONAL, w)]`. Args: `amount u64, increment bool, allowed_counterparty Pubkey` (appended last). Session is `optional: true` in the IDL → Anchor None-sentinel convention: pass the **program ID** (readonly, non-signer) in the session slot on the close path. The increment (tab-open) path REQUIRES a live session.

`lock_voucher`: accounts `[vault(w), vault_usdc_ata(r), swig(r), swig_wallet_address(r), session(w), claim(w), seller_holder(s), dexter_authority(s), payer(s,w), system_program(r), instructions_sysvar(r)]` — session inserted at index 4. Args: `channel_id[32], cumulative u64, sequence u32, voucher_hash[32], maturity_at Option<i64>, holder_recovery_at Option<i64>, allowed_counterparty Pubkey` (appended last).

`migrate_v5_to_v6` (no live session): accounts `[vault(w, AccountInfo), dexter_authority(s), payer(s,w — RECEIVES shrink rent), system_program(r)]`; args EMPTY. Discriminator `[25, 38, 151, 206, 59, 103, 141, 175]`.

`migrate_v5_to_v6_with_session` (live session carried out): accounts `[vault(w), dexter_authority(s), session(w — INIT PDA [b"session", vault, live_counterparty]), payer(s,w — funds PDA rent AND receives shrink rent; must afford rent up-front, init runs pre-handler), system_program(r)]`; args `live_counterparty: Pubkey` (must equal the V5 vault's embedded active_session.allowed_counterparty or the handler reverts). Discriminator `[225, 119, 165, 163, 251, 174, 42, 15]`.

All pre-existing discriminators are unchanged (instruction names unchanged). Messages (188-byte register V2, 128-byte revoke) unchanged — `src/messages/session.ts` is already correct.

### Reference implementations (proven against the live program)

`dexter-vault/tests/helpers/session.ts` (derive/sort/sibling metas), `tests/helpers/register-bootstrap.ts` (`registerSessionV2` full flow + content-aware confirm-visibility), `tests/helpers/secp256r1.ts` (passkey signing + precompile ix). The SDK builders are "promote these patterns to library code" — with the all-writable upgrade noted above.

---

## File structure

```
src/session/                    NEW module (exported as @dexterai/vault/session)
  index.ts                      barrel
  derive.ts                     deriveSessionPda
  decode.ts                     SessionAccountState + decodeSessionAccount + isSessionLive
  fetch.ts                      fetchSessionAccount, fetchVaultSessionAccounts (gPA), buildSiblingAccountMetas
  wait.ts                       waitForSession (content-aware confirm-visibility)
src/constants/index.ts          MODIFY: + 2 migration discriminators, SESSION_SEED, SESSION_ACCOUNT_DISCRIMINATOR, SESSION_ACCOUNT_SIZE
src/types.ts                    MODIFY: + SessionAccountState/SessionRegistrationState; VaultStateFull loses activeSession, gains liveSessionCount; ActiveSession type DELETED
src/reader/accountReader.ts     MODIFY: readVaultFull → V6 (drop activeSession decode, add liveSessionCount)
src/instructions/registerSession.ts   MODIFY: V6 accounts + siblings
src/instructions/revokeSession.ts     MODIFY: V6 accounts + counterparty arg
src/instructions/settleTabVoucher.ts  MODIFY: + session account + counterparty arg
src/instructions/settleVoucher.ts     MODIFY: + optional session + counterparty arg
src/instructions/lockedClaim.ts       MODIFY: lock_voucher + session + counterparty
src/instructions/migrateV5ToV6.ts     NEW: both migration builders
src/instructions/index.ts             MODIFY: + migrateV5ToV6 export
src/index.ts                          MODIFY: + session barrel export
src/idl/dexter_vault.json             REPLACE with V6 IDL
package.json                          MODIFY: + ./session export, version (Task 15 only)
tsup.config.ts                        MODIFY if entry list is explicit: + session entry
tests/session.derive.test.ts          NEW
tests/session.decode.test.ts          NEW
tests/session.fetch.test.ts           NEW
tests/session.wait.test.ts            NEW
tests/v6.byte-parity.test.ts          NEW: all 7 V6-touched builders vs IDL discriminators + account order/flags + arg encoding
tests/reader.test.ts                  MODIFY: V6 vault fixtures
tests/tab.readTabMeter.test.ts        MODIFY: session-PDA based
tests/tab.settleTab.test.ts           MODIFY: counterparty param
tests/tab.openTab.test.ts             MODIFY: counterparty param

dexter-vault repo (live proof, Task 14):
tests/prove-sdk-v6.ts                 NEW: full V6 lifecycle through SDK builders only
```

---

### Task 1: IDL refresh + discriminator/constants audit

**Files:**
- Replace: `src/idl/dexter_vault.json`
- Modify: `src/constants/index.ts`
- Test: `tests/v6.byte-parity.test.ts` (created here, extended in later tasks)

- [ ] **Step 1: Copy the V6 IDL**

Run:
```bash
cp ~/websites/dexter-vault/target/idl/dexter_vault.json ~/websites/dexter-vault-sdk/src/idl/dexter_vault.json
```
Expected: file replaced; `python3 -c "import json; idl=json.load(open('src/idl/dexter_vault.json')); print(len(idl['instructions']))"` prints `28`.

- [ ] **Step 2: Write the failing discriminator-audit test**

Create `tests/v6.byte-parity.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { DISCRIMINATORS, SESSION_ACCOUNT_DISCRIMINATOR } from '../src/constants/index.js';

const idl = JSON.parse(
  readFileSync(new URL('../src/idl/dexter_vault.json', import.meta.url), 'utf8'),
);

function idlDisc(name: string): number[] {
  const ix = idl.instructions.find((i: { name: string }) => i.name === name);
  if (!ix) throw new Error(`instruction ${name} not in IDL`);
  return ix.discriminator;
}

describe('discriminators match the V6 IDL', () => {
  it('every DISCRIMINATORS entry equals the IDL value', () => {
    for (const [name, bytes] of Object.entries(DISCRIMINATORS)) {
      expect(Array.from(bytes), name).toEqual(idlDisc(name));
    }
  });

  it('migration discriminators present', () => {
    expect(Array.from(DISCRIMINATORS.migrate_v5_to_v6)).toEqual([25, 38, 151, 206, 59, 103, 141, 175]);
    expect(Array.from(DISCRIMINATORS.migrate_v5_to_v6_with_session)).toEqual([225, 119, 165, 163, 251, 174, 42, 15]);
  });

  it('SessionAccount account discriminator matches IDL', () => {
    const acct = idl.accounts.find((a: { name: string }) => a.name === 'SessionAccount');
    expect(Array.from(SESSION_ACCOUNT_DISCRIMINATOR)).toEqual(acct.discriminator);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run tests/v6.byte-parity.test.ts`
Expected: FAIL — `migrate_v5_to_v6` missing from DISCRIMINATORS, `SESSION_ACCOUNT_DISCRIMINATOR` not exported.

- [ ] **Step 4: Add the constants**

In `src/constants/index.ts`, append inside the `DISCRIMINATORS` object (after `migrate_v4_to_v5`):

```typescript
  migrate_v5_to_v6:        Uint8Array.from([25, 38, 151, 206, 59, 103, 141, 175]),
  migrate_v5_to_v6_with_session: Uint8Array.from([225, 119, 165, 163, 251, 174, 42, 15]),
```

After the `LOCKED_CLAIM_SEED` line add:

```typescript
// Session PDA seed — matches programs/dexter-vault/src/constants.rs (b"session").
// PDA: [SESSION_SEED, vault, allowed_counterparty]. One per (vault, counterparty);
// re-register REPLACES in place (same seed).
export const SESSION_SEED = Buffer.from('session');

// Anchor account discriminator for SessionAccount (sha256("account:SessionAccount")[..8],
// cross-checked against the V6 IDL). Used as the gPA memcmp filter at offset 0.
export const SESSION_ACCOUNT_DISCRIMINATOR = Uint8Array.from([74, 34, 65, 133, 96, 163, 80, 69]);

// Total SessionAccount size: 8 (discriminator) + 154 (INIT_SPACE). gPA dataSize filter.
export const SESSION_ACCOUNT_SIZE = 162;
```

- [ ] **Step 5: Run tests, expect pass**

Run: `npx vitest run tests/v6.byte-parity.test.ts`
Expected: PASS (3/3).

- [ ] **Step 6: Run the FULL existing suite — establish the baseline**

Run: `npx vitest run`
Expected: the existing `byte-parity.test.ts` snapshot may flag the IDL change; review any failure — discriminator values must NOT have changed for existing instructions (they can't; names are unchanged). Fix snapshots only where the change is the IDL file itself, never the discriminator bytes.

- [ ] **Step 7: Commit**

```bash
git add src/idl/dexter_vault.json src/constants/index.ts tests/v6.byte-parity.test.ts
git commit -m "feat(v6): V6 IDL + migration discriminators + SessionAccount constants"
```

---

### Task 2: `src/session/` — derive + decode + liveness

**Files:**
- Create: `src/session/derive.ts`, `src/session/decode.ts`, `src/session/index.ts`
- Modify: `src/types.ts`
- Test: `tests/session.derive.test.ts`, `tests/session.decode.test.ts`

- [ ] **Step 1: Write the failing derive test**

Create `tests/session.derive.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { deriveSessionPda } from '../src/session/index.js';
import { DEXTER_VAULT_PROGRAM_ID, SESSION_SEED } from '../src/constants/index.js';

describe('deriveSessionPda', () => {
  it('matches findProgramAddressSync over [b"session", vault, counterparty]', () => {
    const vault = new PublicKey('So11111111111111111111111111111111111111112');
    const counterparty = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    const [expected, expectedBump] = PublicKey.findProgramAddressSync(
      [SESSION_SEED, vault.toBuffer(), counterparty.toBuffer()],
      DEXTER_VAULT_PROGRAM_ID,
    );
    const [pda, bump] = deriveSessionPda(vault, counterparty);
    expect(pda.equals(expected)).toBe(true);
    expect(bump).toBe(expectedBump);
  });

  it('different counterparty → different PDA', () => {
    const vault = new PublicKey('So11111111111111111111111111111111111111112');
    const a = deriveSessionPda(vault, PublicKey.unique())[0];
    const b = deriveSessionPda(vault, PublicKey.unique())[0];
    expect(a.equals(b)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/session.derive.test.ts` → FAIL (module not found).

- [ ] **Step 3: Write `src/session/derive.ts`**

```typescript
/**
 * Session PDA derivation — V6 per-counterparty SessionAccount.
 * On-chain seeds (programs/dexter-vault/src/constants.rs + register_session_key.rs):
 *   [b"session", vault, allowed_counterparty]
 * One session per (vault, counterparty); re-register REPLACES in place.
 */
import { PublicKey } from '@solana/web3.js';
import { DEXTER_VAULT_PROGRAM_ID, SESSION_SEED } from '../constants/index.js';

export function deriveSessionPda(
  vault: PublicKey,
  allowedCounterparty: PublicKey,
  programId: PublicKey = DEXTER_VAULT_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SESSION_SEED, vault.toBuffer(), allowedCounterparty.toBuffer()],
    programId,
  );
}
```

- [ ] **Step 4: Add session state types to `src/types.ts`**

Delete the `ActiveSession` interface (lines 21-28) — it describes the removed V5 inline layout and keeping it invites mis-use. In `VaultStateFull`, replace `activeSession: ActiveSession | null;` with `liveSessionCount: number;`. Then append after the vault-state section:

```typescript
// ── V6 SessionAccount (per-counterparty session PDA) ─────────────────────

/** Decoded SessionRegistration — field-for-field mirror of the on-chain struct. */
export interface SessionRegistrationState {
  sessionPubkey: Uint8Array;        // 32 bytes, ed25519
  maxAmount: bigint;                // lifetime cap, atomic units
  expiresAt: number;                // unix seconds
  allowedCounterparty: string;      // base58
  nonce: number;
  spent: bigint;                    // cumulative settled (terminal-settle odometer)
  currentOutstanding: bigint;       // live unsettled exposure (the revolving meter)
  maxRevolvingCapacity: bigint;     // admission cap for the revolving meter
  crystallizedCumulative: bigint;   // lock-terminal odometer
  lastLockedSequence: number;       // reserved; NOT the replay guard
}

/** Decoded SessionAccount PDA. `version === 0` = never-touched OR cleared (by
 *  revoke or the register-time expiry sweep) — the authoritative "no live
 *  session" signal. NOT the Anchor discriminator (which is set before the
 *  handler runs and therefore proves nothing about liveness). */
export interface SessionAccountState {
  address: string;                  // base58 PDA
  version: number;                  // 0 | 1
  bump: number;
  vault: string;                    // base58
  session: SessionRegistrationState;
}
```

- [ ] **Step 5: Write the failing decode test**

Create `tests/session.decode.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { decodeSessionAccount, isSessionLive } from '../src/session/index.js';
import { SESSION_ACCOUNT_DISCRIMINATOR, SESSION_ACCOUNT_SIZE } from '../src/constants/index.js';

/** Build a synthetic 162-byte SessionAccount exactly per the verified layout. */
function fixture(opts: { version?: number; expiresAt?: bigint } = {}): {
  data: Buffer; vault: PublicKey; counterparty: PublicKey; sessionPubkey: Uint8Array;
} {
  const vault = PublicKey.unique();
  const counterparty = PublicKey.unique();
  const sessionPubkey = new Uint8Array(32).fill(7);
  const data = Buffer.alloc(SESSION_ACCOUNT_SIZE);
  Buffer.from(SESSION_ACCOUNT_DISCRIMINATOR).copy(data, 0);
  data.writeUInt8(opts.version ?? 1, 8);
  data.writeUInt8(254, 9);                                  // bump
  vault.toBuffer().copy(data, 10);
  Buffer.from(sessionPubkey).copy(data, 42);
  data.writeBigUInt64LE(5_000_000n, 74);                    // max_amount
  data.writeBigInt64LE(opts.expiresAt ?? 4_000_000_000n, 82); // expires_at (far future)
  counterparty.toBuffer().copy(data, 90);
  data.writeUInt32LE(42, 122);                              // nonce
  data.writeBigUInt64LE(1_250_000n, 126);                   // spent
  data.writeBigUInt64LE(300_000n, 134);                     // current_outstanding
  data.writeBigUInt64LE(2_000_000n, 142);                   // max_revolving_capacity
  data.writeBigUInt64LE(750_000n, 150);                     // crystallized_cumulative
  data.writeUInt32LE(9, 158);                               // last_locked_sequence
  return { data, vault, counterparty, sessionPubkey };
}

describe('decodeSessionAccount', () => {
  it('decodes every field at the verified offsets', () => {
    const f = fixture();
    const s = decodeSessionAccount(PublicKey.unique(), f.data);
    expect(s.version).toBe(1);
    expect(s.bump).toBe(254);
    expect(s.vault).toBe(f.vault.toBase58());
    expect(Array.from(s.session.sessionPubkey)).toEqual(Array.from(f.sessionPubkey));
    expect(s.session.maxAmount).toBe(5_000_000n);
    expect(s.session.expiresAt).toBe(4_000_000_000);
    expect(s.session.allowedCounterparty).toBe(f.counterparty.toBase58());
    expect(s.session.nonce).toBe(42);
    expect(s.session.spent).toBe(1_250_000n);
    expect(s.session.currentOutstanding).toBe(300_000n);
    expect(s.session.maxRevolvingCapacity).toBe(2_000_000n);
    expect(s.session.crystallizedCumulative).toBe(750_000n);
    expect(s.session.lastLockedSequence).toBe(9);
  });

  it('rejects wrong size', () => {
    expect(() => decodeSessionAccount(PublicKey.unique(), Buffer.alloc(161))).toThrow(/size/);
  });

  it('rejects wrong discriminator', () => {
    const f = fixture();
    f.data[0] ^= 0xff;
    expect(() => decodeSessionAccount(PublicKey.unique(), f.data)).toThrow(/discriminator/);
  });
});

describe('isSessionLive', () => {
  it('live: version 1 + future expiry', () => {
    const s = decodeSessionAccount(PublicKey.unique(), fixture().data);
    expect(isSessionLive(s, 1_900_000_000)).toBe(true);
  });
  it('not live: version 0 (cleared) even with future expiry', () => {
    const s = decodeSessionAccount(PublicKey.unique(), fixture({ version: 0 }).data);
    expect(isSessionLive(s, 1_900_000_000)).toBe(false);
  });
  it('not live: expired', () => {
    const s = decodeSessionAccount(PublicKey.unique(), fixture({ expiresAt: 1_000n }).data);
    expect(isSessionLive(s, 1_900_000_000)).toBe(false);
  });
});
```

- [ ] **Step 6: Run to verify it fails** — `npx vitest run tests/session.decode.test.ts` → FAIL.

- [ ] **Step 7: Write `src/session/decode.ts`**

```typescript
/**
 * SessionAccount decoder — V6 per-counterparty session PDA.
 *
 * Byte layout (verified against programs/dexter-vault/src/state.rs on the
 * deployed feat/vault-v6-multisession build, 2026-06-09):
 *   0   8  Anchor discriminator
 *   8   1  version u8        (0 = never-touched/cleared; 1 = live-written)
 *   9   1  bump u8
 *  10  32  vault
 *  42  32  session_pubkey
 *  74   8  max_amount u64
 *  82   8  expires_at i64
 *  90  32  allowed_counterparty
 * 122   4  nonce u32
 * 126   8  spent u64
 * 134   8  current_outstanding u64
 * 142   8  max_revolving_capacity u64
 * 150   8  crystallized_cumulative u64
 * 158   4  last_locked_sequence u32   (total 162)
 *
 * `version` is the PROGRAM's liveness field, NOT the Anchor discriminator —
 * Anchor sets the discriminator on init_if_needed BEFORE the handler runs, so
 * discriminator-present proves nothing. version === 0 is authoritative
 * "no live session here" (cleared by revoke, the register-time expiry sweep,
 * or a failed first register).
 */
import { PublicKey } from '@solana/web3.js';
import { SESSION_ACCOUNT_DISCRIMINATOR, SESSION_ACCOUNT_SIZE } from '../constants/index.js';
import type { SessionAccountState } from '../types.js';

export function decodeSessionAccount(address: PublicKey, data: Buffer | Uint8Array): SessionAccountState {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length !== SESSION_ACCOUNT_SIZE) {
    throw new Error(`SessionAccount wrong size: ${buf.length}, expected ${SESSION_ACCOUNT_SIZE}`);
  }
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== SESSION_ACCOUNT_DISCRIMINATOR[i]) {
      throw new Error('SessionAccount wrong discriminator (not a SessionAccount)');
    }
  }
  return {
    address: address.toBase58(),
    version: buf.readUInt8(8),
    bump: buf.readUInt8(9),
    vault: new PublicKey(buf.subarray(10, 42)).toBase58(),
    session: {
      sessionPubkey: new Uint8Array(buf.subarray(42, 74)),
      maxAmount: buf.readBigUInt64LE(74),
      expiresAt: Number(buf.readBigInt64LE(82)),
      allowedCounterparty: new PublicKey(buf.subarray(90, 122)).toBase58(),
      nonce: buf.readUInt32LE(122),
      spent: buf.readBigUInt64LE(126),
      currentOutstanding: buf.readBigUInt64LE(134),
      maxRevolvingCapacity: buf.readBigUInt64LE(142),
      crystallizedCumulative: buf.readBigUInt64LE(150),
      lastLockedSequence: buf.readUInt32LE(158),
    },
  };
}

/** Liveness = written (version 1) AND unexpired. `nowSeconds` injectable for tests. */
export function isSessionLive(
  s: SessionAccountState,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  return s.version === 1 && s.session.expiresAt > nowSeconds;
}
```

- [ ] **Step 8: Write `src/session/index.ts`** (extended in Tasks 3 and 12):

```typescript
export * from './derive.js';
export * from './decode.js';
```

- [ ] **Step 9: Run both test files, expect pass** — `npx vitest run tests/session.derive.test.ts tests/session.decode.test.ts` → PASS.

- [ ] **Step 10: Commit**

```bash
git add src/session src/types.ts tests/session.derive.test.ts tests/session.decode.test.ts
git commit -m "feat(v6): session module — PDA derive + SessionAccount decode + liveness"
```

Note: `src/types.ts` edits will break `src/reader/accountReader.ts` and `src/tab/*` compilation — that is EXPECTED until Tasks 9-10. Run vitest per-file in Tasks 2-8; the full `typecheck` gate is Task 13. If the commit-time test run trips on unrelated compile errors, scope vitest to the new files as shown.

---

### Task 3: `src/session/fetch.ts` — sibling discovery + sibling metas

**Files:**
- Create: `src/session/fetch.ts`
- Modify: `src/session/index.ts`
- Test: `tests/session.fetch.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/session.fetch.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { Connection, PublicKey } from '@solana/web3.js';
import {
  fetchVaultSessionAccounts,
  buildSiblingAccountMetas,
} from '../src/session/index.js';
import { SESSION_ACCOUNT_DISCRIMINATOR, SESSION_ACCOUNT_SIZE } from '../src/constants/index.js';

function rawSession(vault: PublicKey, counterparty: PublicKey, version: number): Buffer {
  const data = Buffer.alloc(SESSION_ACCOUNT_SIZE);
  Buffer.from(SESSION_ACCOUNT_DISCRIMINATOR).copy(data, 0);
  data.writeUInt8(version, 8);
  data.writeUInt8(255, 9);
  vault.toBuffer().copy(data, 10);
  data.writeBigInt64LE(4_000_000_000n, 82);
  counterparty.toBuffer().copy(data, 90);
  return data;
}

describe('fetchVaultSessionAccounts', () => {
  it('queries gPA with discriminator+vault filters and drops version==0', async () => {
    const vault = PublicKey.unique();
    const cpA = PublicKey.unique();
    const cpB = PublicKey.unique();
    const accounts = [
      { pubkey: PublicKey.unique(), account: { data: rawSession(vault, cpA, 1) } },
      { pubkey: PublicKey.unique(), account: { data: rawSession(vault, cpB, 0) } }, // cleared
    ];
    const conn = {
      getProgramAccounts: vi.fn().mockResolvedValue(accounts),
    } as unknown as Connection;

    const out = await fetchVaultSessionAccounts(conn, vault);
    expect(out).toHaveLength(1);
    expect(out[0].session.allowedCounterparty).toBe(cpA.toBase58());

    const [programId, cfg] = (conn.getProgramAccounts as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(programId.toBase58()).toBe('Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc');
    expect(cfg.filters).toEqual([
      { dataSize: SESSION_ACCOUNT_SIZE },
      { memcmp: { offset: 0, bytes: expect.any(String) } },
      { memcmp: { offset: 10, bytes: vault.toBase58() } },
    ]);
    expect(cfg.commitment).toBe('confirmed');
  });
});

describe('buildSiblingAccountMetas', () => {
  it('excludes the target, sorts strict-ascending by raw bytes, marks ALL writable', () => {
    const keys = Array.from({ length: 5 }, () => PublicKey.unique());
    const target = keys[2];
    const metas = buildSiblingAccountMetas(keys, target);
    expect(metas).toHaveLength(4);
    expect(metas.every((m) => m.isWritable && !m.isSigner)).toBe(true);
    expect(metas.some((m) => m.pubkey.equals(target))).toBe(false);
    for (let i = 1; i < metas.length; i++) {
      expect(Buffer.compare(metas[i - 1].pubkey.toBuffer(), metas[i].pubkey.toBuffer())).toBeLessThan(0);
    }
  });

  it('dedups an accidentally-duplicated sibling', () => {
    const k = PublicKey.unique();
    const metas = buildSiblingAccountMetas([k, k], PublicKey.unique());
    expect(metas).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/session.fetch.test.ts` → FAIL.

- [ ] **Step 3: Write `src/session/fetch.ts`**

```typescript
/**
 * Sibling discovery + sibling-meta construction for the V6 register gate.
 *
 * THE CONTRACT (programs/dexter-vault/src/instructions/register_session_key.rs,
 * handler step C — get this exactly right or the register REVERTS):
 *  - remaining_accounts must contain EVERY OTHER SessionAccount of this vault
 *    whose version != 0 (live AND expired-unswept), excluding the target.
 *    Cleared accounts (version == 0) must NOT be passed (they're not counted
 *    by live_session_count → completeness would fail).
 *  - STRICT ASCENDING by raw 32-byte pubkey (the gate checks `>` per step).
 *  - ALL passed as writable. The program only REQUIRES writability on expired
 *    siblings (the sweep persists a clear), but a sibling that is live at
 *    fetch time can expire before the tx executes — all-writable removes that
 *    race for the cost of extra write locks on program-owned PDAs.
 *  - Fetch FRESH immediately before building + sending: the gate sweeps expired
 *    siblings (decrementing live_session_count), so a stale list double-counts
 *    a since-swept sibling and fails the completeness equation.
 */
import { Connection, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import {
  DEXTER_VAULT_PROGRAM_ID,
  SESSION_ACCOUNT_DISCRIMINATOR,
  SESSION_ACCOUNT_SIZE,
} from '../constants/index.js';
import { decodeSessionAccount } from './decode.js';
import { deriveSessionPda } from './derive.js';
import type { SessionAccountState } from '../types.js';

/** Fetch one session PDA for (vault, counterparty). null = account absent.
 *  An account with version === 0 is returned as-is — callers decide liveness
 *  via isSessionLive (absent and cleared mean the same thing to the program). */
export async function fetchSessionAccount(
  connection: Connection,
  vault: PublicKey,
  allowedCounterparty: PublicKey,
  programId: PublicKey = DEXTER_VAULT_PROGRAM_ID,
): Promise<SessionAccountState | null> {
  const [pda] = deriveSessionPda(vault, allowedCounterparty, programId);
  const info = await connection.getAccountInfo(pda, 'confirmed');
  if (!info) return null;
  return decodeSessionAccount(pda, info.data);
}

/** All version != 0 SessionAccounts for a vault (live + expired-unswept) — the
 *  exact population the register gate's completeness equation counts. */
export async function fetchVaultSessionAccounts(
  connection: Connection,
  vault: PublicKey,
  programId: PublicKey = DEXTER_VAULT_PROGRAM_ID,
): Promise<SessionAccountState[]> {
  const raw = await connection.getProgramAccounts(programId, {
    commitment: 'confirmed',
    filters: [
      { dataSize: SESSION_ACCOUNT_SIZE },
      { memcmp: { offset: 0, bytes: bs58.encode(SESSION_ACCOUNT_DISCRIMINATOR) } },
      { memcmp: { offset: 10, bytes: vault.toBase58() } },
    ],
  });
  return raw
    .map(({ pubkey, account }) => decodeSessionAccount(pubkey, account.data))
    .filter((s) => s.version !== 0);
}

/** Sibling AccountMeta[] for the register gate: target excluded, deduped,
 *  strict-ascending raw-byte order (== Rust Pubkey Ord), ALL writable. */
export function buildSiblingAccountMetas(
  siblingPdas: PublicKey[],
  targetSessionPda: PublicKey,
): { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] {
  const seen = new Set<string>();
  const unique: PublicKey[] = [];
  for (const k of siblingPdas) {
    const b58 = k.toBase58();
    if (k.equals(targetSessionPda) || seen.has(b58)) continue;
    seen.add(b58);
    unique.push(k);
  }
  unique.sort((a, b) => Buffer.compare(a.toBuffer(), b.toBuffer()));
  return unique.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true }));
}
```

Note: `bs58` is already a transitive dep of @solana/web3.js; add it as a direct dependency: `npm install bs58` (pin whatever major web3.js already uses — check `npm ls bs58`).

- [ ] **Step 4: Export from the barrel** — `src/session/index.ts` gains `export * from './fetch.js';`

- [ ] **Step 5: Run tests, expect pass** — `npx vitest run tests/session.fetch.test.ts` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/session tests/session.fetch.test.ts package.json package-lock.json
git commit -m "feat(v6): sibling discovery (gPA) + all-writable sibling metas for the register gate"
```

---

### Task 4: registerSession builder — V6 accounts + siblings

**Files:**
- Modify: `src/instructions/registerSession.ts`
- Test: extend `tests/v6.byte-parity.test.ts`

- [ ] **Step 1: Write the failing test** (append to `tests/v6.byte-parity.test.ts`):

```typescript
import { PublicKey, SystemProgram } from '@solana/web3.js';
import { buildRegisterSessionKeyInstruction } from '../src/instructions/registerSession.js';
import { deriveSessionPda, buildSiblingAccountMetas } from '../src/session/index.js';
import { INSTRUCTIONS_SYSVAR_ID } from '../src/constants/index.js';

describe('buildRegisterSessionKeyInstruction (V6)', () => {
  const vaultPda = PublicKey.unique();
  const swigAddress = PublicKey.unique();
  const vaultUsdcAta = PublicKey.unique();
  const payer = PublicKey.unique();
  const counterparty = PublicKey.unique();
  const siblings = [PublicKey.unique(), PublicKey.unique()];

  const ix = buildRegisterSessionKeyInstruction({
    vaultPda,
    sessionPubkey: new Uint8Array(32).fill(1),
    maxAmount: 1_000_000n,
    expiresAt: 4_000_000_000n,
    allowedCounterparty: counterparty,
    nonce: 7,
    maxRevolvingCapacity: 500_000n,
    swigAddress,
    vaultUsdcAta,
    payer,
    siblingSessionPdas: siblings,
    clientDataJSON: new Uint8Array([1, 2]),
    authenticatorData: new Uint8Array(37),
  });

  it('has the 8 fixed accounts in program order, then sorted writable siblings', () => {
    const [sessionPda] = deriveSessionPda(vaultPda, counterparty);
    const expectedSiblings = buildSiblingAccountMetas(siblings, sessionPda);
    expect(ix.keys.length).toBe(8 + expectedSiblings.length);
    expect(ix.keys[0]).toEqual({ pubkey: vaultPda, isSigner: false, isWritable: true });
    expect(ix.keys[1]).toEqual({ pubkey: vaultUsdcAta, isSigner: false, isWritable: false });
    expect(ix.keys[2].pubkey.equals(swigAddress)).toBe(true);
    // keys[3] = swig_wallet_address (derived) — readonly non-signer
    expect(ix.keys[3].isWritable).toBe(false);
    expect(ix.keys[4].pubkey.equals(INSTRUCTIONS_SYSVAR_ID)).toBe(true);
    expect(ix.keys[5]).toEqual({ pubkey: sessionPda, isSigner: false, isWritable: true });
    expect(ix.keys[6]).toEqual({ pubkey: payer, isSigner: true, isWritable: true });
    expect(ix.keys[7].pubkey.equals(SystemProgram.programId)).toBe(true);
    for (let i = 0; i < expectedSiblings.length; i++) {
      expect(ix.keys[8 + i]).toEqual(expectedSiblings[i]);
    }
  });

  it('data layout unchanged from V5 (args did not change)', () => {
    // disc(8) + pubkey(32) + u64 + i64 + pubkey(32) + u32 + u64 + vec(2) + vec(37)
    expect(ix.data.length).toBe(8 + 32 + 8 + 8 + 32 + 4 + 8 + (4 + 2) + (4 + 37));
  });
});
```

- [ ] **Step 2: Run to verify it fails** — new params not accepted → compile/type FAIL.

- [ ] **Step 3: Implement.** In `src/instructions/registerSession.ts`: update the doc-block account list to the 8-account V6 order + siblings; extend the interface and builder:

```typescript
// interface additions:
export interface BuildRegisterSessionKeyArgs {
  vaultPda: PublicKey;
  sessionPubkey: Uint8Array;
  maxAmount: bigint;
  expiresAt: bigint;
  allowedCounterparty: PublicKey;
  nonce: number;
  maxRevolvingCapacity: bigint;
  swigAddress: PublicKey;
  vaultUsdcAta: PublicKey;
  /** V6: funds the session PDA rent on first creation (signer, writable). */
  payer: PublicKey;
  /** V6: EVERY OTHER version!=0 SessionAccount PDA of this vault (live AND
   *  expired-unswept), target excluded — fetch FRESH via
   *  fetchVaultSessionAccounts immediately before building. The builder
   *  excludes/dedups/sorts and marks all writable. Wrong/stale set → the
   *  program reverts (IncompleteSessionSet / SessionAccountsNotSorted /
   *  SessionWouldOvercommitVault...). */
  siblingSessionPdas: PublicKey[];
  clientDataJSON: Uint8Array;
  authenticatorData: Uint8Array;
}
```

```typescript
// builder body (data encoding UNCHANGED; keys replaced):
import { SystemProgram } from '@solana/web3.js';
import { deriveSessionPda, buildSiblingAccountMetas } from '../session/index.js';

  const swigWalletAddress = deriveSwigWalletAddress(args.swigAddress);
  const [sessionPda] = deriveSessionPda(args.vaultPda, args.allowedCounterparty);
  const siblingMetas = buildSiblingAccountMetas(args.siblingSessionPdas, sessionPda);

  return new TransactionInstruction({
    keys: [
      { pubkey: args.vaultPda, isSigner: false, isWritable: true },
      { pubkey: args.vaultUsdcAta, isSigner: false, isWritable: false },
      { pubkey: args.swigAddress, isSigner: false, isWritable: false },
      { pubkey: swigWalletAddress, isSigner: false, isWritable: false },
      { pubkey: INSTRUCTIONS_SYSVAR_ID, isSigner: false, isWritable: false },
      { pubkey: sessionPda, isSigner: false, isWritable: true },
      { pubkey: args.payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ...siblingMetas,
    ],
    programId: DEXTER_VAULT_PROGRAM_ID,
    data: Buffer.from(data),
  });
```

- [ ] **Step 4: Run tests, expect pass.** Existing register tests in the suite that call the old signature will fail to compile — update their call sites with `payer` + `siblingSessionPdas: []` and the new expected account count. Their byte-data assertions stay valid (args unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/instructions/registerSession.ts tests/v6.byte-parity.test.ts tests/byte-parity.test.ts
git commit -m "feat(v6): register_session_key builder — session PDA + payer + sorted writable siblings"
```

---

### Task 5: revokeSession builder — V6

**Files:**
- Modify: `src/instructions/revokeSession.ts`
- Test: extend `tests/v6.byte-parity.test.ts`

- [ ] **Step 1: Write the failing test** (append):

```typescript
import { buildRevokeSessionKeyInstruction } from '../src/instructions/revokeSession.js';

describe('buildRevokeSessionKeyInstruction (V6)', () => {
  const vaultPda = PublicKey.unique();
  const counterparty = PublicKey.unique();
  const ix = buildRevokeSessionKeyInstruction({
    vaultPda,
    allowedCounterparty: counterparty,
    clientDataJSON: new Uint8Array([9]),
    authenticatorData: new Uint8Array(37),
  });

  it('accounts: [vault(w), session(w), instructions_sysvar(r)]', () => {
    const [sessionPda] = deriveSessionPda(vaultPda, counterparty);
    expect(ix.keys).toEqual([
      { pubkey: vaultPda, isSigner: false, isWritable: true },
      { pubkey: sessionPda, isSigner: false, isWritable: true },
      { pubkey: INSTRUCTIONS_SYSVAR_ID, isSigner: false, isWritable: false },
    ]);
  });

  it('args: counterparty(32) FIRST, then the two vecs', () => {
    expect(ix.data.length).toBe(8 + 32 + (4 + 1) + (4 + 37));
    expect(Buffer.from(ix.data.subarray(8, 40)).equals(counterparty.toBuffer())).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement.** Replace the stale doc-block (it still narrates "vault.active_session" — V6 reads the session PDA; the signed 128-byte message embeds the session_pubkey READ FROM THE PDA, so callers fetch it via `fetchSessionAccount` to build the message). New interface + body:

```typescript
export interface BuildRevokeSessionKeyArgs {
  vaultPda: PublicKey;
  /** V6: names the session PDA being revoked (Borsh arg AND PDA seed). */
  allowedCounterparty: PublicKey;
  clientDataJSON: Uint8Array;
  authenticatorData: Uint8Array;
}

export function buildRevokeSessionKeyInstruction(
  args: BuildRevokeSessionKeyArgs,
): TransactionInstruction {
  const data = concatBytes(
    DISCRIMINATORS.revoke_session_key,
    args.allowedCounterparty.toBytes(),
    encodeVecU8(args.clientDataJSON),
    encodeVecU8(args.authenticatorData),
  );
  const [sessionPda] = deriveSessionPda(args.vaultPda, args.allowedCounterparty);
  return new TransactionInstruction({
    keys: [
      { pubkey: args.vaultPda, isSigner: false, isWritable: true },
      { pubkey: sessionPda, isSigner: false, isWritable: true },
      { pubkey: INSTRUCTIONS_SYSVAR_ID, isSigner: false, isWritable: false },
    ],
    programId: DEXTER_VAULT_PROGRAM_ID,
    data: Buffer.from(data),
  });
}
```

(import `deriveSessionPda` from `../session/index.js`)

- [ ] **Step 4: Run tests, expect pass; fix old call sites.**
- [ ] **Step 5: Commit** — `git commit -m "feat(v6): revoke_session_key builder — session PDA + counterparty arg"`

---

### Task 6: settleTabVoucher builder — V6

**Files:**
- Modify: `src/instructions/settleTabVoucher.ts`
- Test: extend `tests/v6.byte-parity.test.ts`

- [ ] **Step 1: Failing test** (append):

```typescript
import { buildSettleTabVoucherInstruction } from '../src/instructions/settleTabVoucher.js';

describe('buildSettleTabVoucherInstruction (V6)', () => {
  const vaultPda = PublicKey.unique();
  const swigAddress = PublicKey.unique();
  const dexterAuthority = PublicKey.unique();
  const counterparty = PublicKey.unique();
  const ix = buildSettleTabVoucherInstruction({
    vaultPda, swigAddress, dexterAuthority,
    channelId: new Uint8Array(32).fill(3),
    cumulativeAmount: 777n,
    sequenceNumber: 5,
    allowedCounterparty: counterparty,
  });

  it('session PDA at index 3, writable', () => {
    const [sessionPda] = deriveSessionPda(vaultPda, counterparty);
    expect(ix.keys.length).toBe(6);
    expect(ix.keys[2]).toEqual({ pubkey: vaultPda, isSigner: false, isWritable: true });
    expect(ix.keys[3]).toEqual({ pubkey: sessionPda, isSigner: false, isWritable: true });
    expect(ix.keys[4]).toEqual({ pubkey: dexterAuthority, isSigner: true, isWritable: false });
  });

  it('counterparty appended LAST in args', () => {
    expect(ix.data.length).toBe(8 + 32 + 8 + 4 + 32);
    expect(Buffer.from(ix.data.subarray(52, 84)).equals(counterparty.toBuffer())).toBe(true);
  });
});
```

- [ ] **Step 2: Run, verify fail. Step 3: Implement** — add `allowedCounterparty: PublicKey` to `SettleTabVoucherParams`; append `p.allowedCounterparty.toBuffer()` to `argsBuf`; insert the derived session PDA `{ isSigner: false, isWritable: true }` between vault and dexter_authority. Update the doc-block account list.

- [ ] **Step 4: Run tests + fix old call sites (tab.settleTab.test.ts compiles in Task 10). Step 5: Commit** — `git commit -m "feat(v6): settle_tab_voucher builder — session PDA + counterparty arg"`

---

### Task 7: settleVoucher builder — V6 optional session

**Files:**
- Modify: `src/instructions/settleVoucher.ts`
- Test: extend `tests/v6.byte-parity.test.ts`

- [ ] **Step 1: Failing test** (append):

```typescript
import { buildSettleVoucherInstruction } from '../src/instructions/settleVoucher.js';
import { DEXTER_VAULT_PROGRAM_ID } from '../src/constants/index.js';

describe('buildSettleVoucherInstruction (V6)', () => {
  const vaultPda = PublicKey.unique();
  const dexterAuthority = PublicKey.unique();
  const counterparty = PublicKey.unique();

  it('increment (tab-open) passes the session PDA writable', () => {
    const ix = buildSettleVoucherInstruction({
      vaultPda, dexterAuthority, amount: 100n, increment: true,
      allowedCounterparty: counterparty,
    });
    const [sessionPda] = deriveSessionPda(vaultPda, counterparty);
    expect(ix.keys[2]).toEqual({ pubkey: sessionPda, isSigner: false, isWritable: true });
  });

  it('close path uses the program-ID None sentinel (Anchor optional account)', () => {
    const ix = buildSettleVoucherInstruction({
      vaultPda, dexterAuthority, amount: 100n, increment: false,
      allowedCounterparty: counterparty,
    });
    expect(ix.keys[2]).toEqual({
      pubkey: DEXTER_VAULT_PROGRAM_ID, isSigner: false, isWritable: false,
    });
  });

  it('args gain counterparty LAST', () => {
    const ix = buildSettleVoucherInstruction({
      vaultPda, dexterAuthority, amount: 100n, increment: true,
      allowedCounterparty: counterparty,
    });
    expect(ix.data.length).toBe(8 + 8 + 1 + 32);
    expect(Buffer.from(ix.data.subarray(17, 49)).equals(counterparty.toBuffer())).toBe(true);
  });
});
```

- [ ] **Step 2: Run, verify fail. Step 3: Implement:**

```typescript
export interface SettleVoucherParams {
  vaultPda: PublicKey;
  dexterAuthority: PublicKey;
  amount: bigint;
  increment: boolean;
  /** V6: the counterparty whose session meter rises at tab-open. Required in
   *  args on both paths (Borsh); the session ACCOUNT is only passed on the
   *  increment path — the close path uses Anchor's optional-account None
   *  sentinel (the program ID). */
  allowedCounterparty: PublicKey;
}

export function buildSettleVoucherInstruction(p: SettleVoucherParams): TransactionInstruction {
  const argsBuf = Buffer.concat([
    encodeU64(p.amount),
    encodeBool(p.increment),
    p.allowedCounterparty.toBuffer(),
  ]);
  const data = Buffer.concat([Buffer.from(DISCRIMINATORS.settle_voucher), argsBuf]);
  const sessionMeta = p.increment
    ? { pubkey: deriveSessionPda(p.vaultPda, p.allowedCounterparty)[0], isSigner: false, isWritable: true }
    : { pubkey: DEXTER_VAULT_PROGRAM_ID, isSigner: false, isWritable: false };
  return new TransactionInstruction({
    programId: DEXTER_VAULT_PROGRAM_ID,
    keys: [
      { pubkey: p.vaultPda, isSigner: false, isWritable: true },
      { pubkey: p.dexterAuthority, isSigner: true, isWritable: false },
      sessionMeta,
    ],
    data,
  });
}
```

- [ ] **Step 4: Run + fix call sites. Step 5: Commit** — `git commit -m "feat(v6): settle_voucher builder — optional session PDA (None = program-ID sentinel)"`

---

### Task 8: lockVoucher builder — V6

**Files:**
- Modify: `src/instructions/lockedClaim.ts` (only `LockVoucherParams` + `buildLockVoucherInstruction`; the other three claim builders are UNCHANGED at V6)
- Test: extend `tests/v6.byte-parity.test.ts`

- [ ] **Step 1: Failing test** (append):

```typescript
import { buildLockVoucherInstruction, deriveLockedClaimPda } from '../src/instructions/lockedClaim.js';

describe('buildLockVoucherInstruction (V6)', () => {
  const vaultPda = PublicKey.unique();
  const counterparty = PublicKey.unique();
  const voucherHash = new Uint8Array(32).fill(8);
  const ix = buildLockVoucherInstruction({
    vaultPda,
    vaultUsdcAta: PublicKey.unique(),
    swigAddress: PublicKey.unique(),
    sellerHolder: PublicKey.unique(),
    dexterAuthority: PublicKey.unique(),
    payer: PublicKey.unique(),
    channelId: new Uint8Array(32).fill(2),
    cumulativeAmount: 999n,
    sequenceNumber: 3,
    voucherHash,
    maturityAt: null,
    holderRecoveryAt: null,
    allowedCounterparty: counterparty,
  });

  it('session PDA at index 4, writable; 11 accounts total', () => {
    const [sessionPda] = deriveSessionPda(vaultPda, counterparty);
    expect(ix.keys.length).toBe(11);
    expect(ix.keys[4]).toEqual({ pubkey: sessionPda, isSigner: false, isWritable: true });
    expect(ix.keys[5].pubkey.equals(deriveLockedClaimPda(vaultPda, voucherHash))).toBe(true);
  });

  it('counterparty appended LAST (after both Option<i64> None bytes)', () => {
    expect(ix.data.length).toBe(8 + 32 + 8 + 4 + 32 + 1 + 1 + 32);
    expect(Buffer.from(ix.data.subarray(ix.data.length - 32)).equals(counterparty.toBuffer())).toBe(true);
  });
});
```

- [ ] **Step 2: Run, verify fail. Step 3: Implement** — add `allowedCounterparty: PublicKey` to `LockVoucherParams`; append `p.allowedCounterparty.toBuffer()` after `encodeOptionI64(p.holderRecoveryAt)` in the data concat; insert the derived session PDA writable at index 4 (between swig_wallet_address and claim). Update the doc-block account list to the 11-account order.

- [ ] **Step 4: Run + fix call sites (lockedClaim.byte-parity.test.ts). Step 5: Commit** — `git commit -m "feat(v6): lock_voucher builder — session PDA at index 4 + counterparty arg"`

---

### Task 9: vault reader — V6 (the silent-corruption fix)

**Files:**
- Modify: `src/reader/accountReader.ts`
- Test: modify `tests/reader.test.ts`

- [ ] **Step 1: Write the failing tests.** In `tests/reader.test.ts`, replace the activeSession-decode cases with V6 fixtures (build vault bytes per the V6 layout: through dexter_authority identical to V5; then ONE byte `live_session_count`). Required cases:

```typescript
// 1. readVaultFull on a V6 vault with live_session_count = 3 → { liveSessionCount: 3 }
//    and NO activeSession property at all (compile-level: VaultStateFull has no such field).
// 2. readVaultFull with live_session_count = 0 → liveSessionCount 0.
// 3. withdrawal-present fixture → liveSessionCount still decoded at the shifted offset.
// 4. readVaultOnchain (slim) — UNCHANGED behavior, existing cases keep passing
//    (fields through pending_withdrawal didn't move).
```

Fixture builder (add to the test file):

```typescript
function v6VaultBytes(opts: { liveSessionCount: number; withdrawal?: boolean }): Buffer {
  const withdrawalBody = opts.withdrawal ? 48 : 0;
  const len = 8 + 1 + 1 + 33 + 32 + 4 + 4 + 1 + withdrawalBody + 32 + 32 + 1 + 8 + 8 + 8 + 8 + 1 + 8 + 1;
  const data = Buffer.alloc(len);
  data.writeUInt8(6, 8);                       // version = 6
  // bump, passkey(33), swig(32) at 9,10,43 — fill swig so the reader returns it
  PublicKey.unique().toBuffer().copy(data, 43);
  data.writeUInt32LE(2, 79);                   // pending_voucher_count
  data.writeUInt8(opts.withdrawal ? 1 : 0, 83);
  const afterWithdrawal = 84 + withdrawalBody;
  // identity_claim(32) then dexter_authority(32)
  PublicKey.unique().toBuffer().copy(data, afterWithdrawal + 32);
  data.writeUInt8(opts.liveSessionCount, afterWithdrawal + 64); // live_session_count
  return data;
}
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement.** In `src/reader/accountReader.ts`: rewrite the layout doc-comment for V6; delete `ACTIVE_SESSION_BODY_LEN` and the whole activeSession decode block; replace with:

```typescript
  const liveSessionCountOffset = dexterAuthorityOffset + PUBKEY_LEN;
  const liveSessionCount =
    data.length > liveSessionCountOffset ? data.readUInt8(liveSessionCountOffset) : 0;

  return {
    exists: true,
    version,
    swigAddress,
    dexterAuthority,
    pendingVoucherCount,
    liveSessionCount,
  };
```

and update `EMPTY_FULL` to `{ exists: false, version: 0, swigAddress: null, dexterAuthority: null, pendingVoucherCount: 0, liveSessionCount: 0 }`. `readVaultOnchain` is untouched.

- [ ] **Step 4: Run tests, expect pass. Step 5: Commit** — `git commit -m "fix(v6)!: vault reader — drop active_session decode (mis-decodes V6 bytes), add liveSessionCount"`

---

### Task 10: tab layer — session reads move to the PDA

**Files:**
- Modify: `src/tab/readTabMeter.ts`, `src/tab/settleTab.ts`, `src/tab/openTab.ts`
- Test: modify `tests/tab.readTabMeter.test.ts`, `tests/tab.settleTab.test.ts`, `tests/tab.openTab.test.ts`

- [ ] **Step 1: Failing tests.** Update the three tab test files to the new signatures:
  - `readTabMeter(connection, vaultPda, allowedCounterparty)` → mocked `fetchSessionAccount` returns a live session → meter `{spent, maxAmount, remaining}`; absent/version-0 session → throws `no live session for counterparty`.
  - `settleTab` params gain `allowedCounterparty: PublicKey`; `defaultReadPriorSpent` reads the session PDA's `spent`; the built `settle_tab_voucher` ix carries the session at index 3 (assert via the keys array).
  - `openTab` params gain `allowedCounterparty`; the settle_voucher leg passes the session PDA (increment path).

- [ ] **Step 2: Run, verify fail. Step 3: Implement:**

`src/tab/readTabMeter.ts`:

```typescript
import { Connection, PublicKey } from '@solana/web3.js';
import { fetchSessionAccount, isSessionLive } from '../session/index.js';
import type { SessionAccountState } from '../types.js';

export interface TabMeter {
  spent: bigint;
  maxAmount: bigint;
  remaining: bigint;          // max(0, maxAmount - spent)
  currentOutstanding: bigint; // V6: the revolving meter, exposed for free
  expiresAt: number;
}

export async function readTabMeter(
  connection: Connection,
  vaultPda: PublicKey,
  allowedCounterparty: PublicKey,
  fetch: typeof fetchSessionAccount = fetchSessionAccount,
): Promise<TabMeter> {
  const s: SessionAccountState | null = await fetch(connection, vaultPda, allowedCounterparty);
  if (!s || !isSessionLive(s)) {
    throw new Error(
      `readTabMeter: no live session for counterparty ${allowedCounterparty.toBase58()}`,
    );
  }
  const { spent, maxAmount, currentOutstanding, expiresAt } = s.session;
  const raw = maxAmount - spent;
  return { spent, maxAmount, remaining: raw > 0n ? raw : 0n, currentOutstanding, expiresAt };
}
```

`src/tab/settleTab.ts`: add `allowedCounterparty: PublicKey` to `SettleTabParams`; `defaultReadPriorSpent` becomes a session-PDA read (`fetchSessionAccount` → throw if `!s || s.version === 0` → return `s.session.spent`); `readPriorSpent` injectable signature gains the counterparty; pass `allowedCounterparty` through to `buildSettleTabVoucherInstruction`.

`src/tab/openTab.ts`: add `allowedCounterparty: PublicKey` to `OpenTabParams` and pass to `buildSettleVoucherInstruction` (increment path always passes the session).

- [ ] **Step 4: Run the three tab test files, expect pass. Step 5: Commit** — `git commit -m "feat(v6)!: tab layer reads the session PDA (readTabMeter/settleTab/openTab take counterparty)"`

---

### Task 11: migration builders (both variants)

**Files:**
- Create: `src/instructions/migrateV5ToV6.ts`
- Modify: `src/instructions/index.ts`
- Test: extend `tests/v6.byte-parity.test.ts`

- [ ] **Step 1: Failing test** (append):

```typescript
import {
  buildMigrateV5ToV6Instruction,
  buildMigrateV5ToV6WithSessionInstruction,
} from '../src/instructions/migrateV5ToV6.js';

describe('migrate_v5_to_v6 builders', () => {
  const vaultPda = PublicKey.unique();
  const dexterAuthority = PublicKey.unique();
  const payer = PublicKey.unique();

  it('plain: 4 accounts, empty args', () => {
    const ix = buildMigrateV5ToV6Instruction({ vaultPda, dexterAuthority, payer });
    expect(ix.keys).toEqual([
      { pubkey: vaultPda, isSigner: false, isWritable: true },
      { pubkey: dexterAuthority, isSigner: true, isWritable: false },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ]);
    expect(ix.data.length).toBe(8);
    expect(Array.from(ix.data)).toEqual([25, 38, 151, 206, 59, 103, 141, 175]);
  });

  it('with_session: session PDA at index 2, counterparty arg', () => {
    const counterparty = PublicKey.unique();
    const ix = buildMigrateV5ToV6WithSessionInstruction({
      vaultPda, dexterAuthority, payer, liveCounterparty: counterparty,
    });
    const [sessionPda] = deriveSessionPda(vaultPda, counterparty);
    expect(ix.keys).toEqual([
      { pubkey: vaultPda, isSigner: false, isWritable: true },
      { pubkey: dexterAuthority, isSigner: true, isWritable: false },
      { pubkey: sessionPda, isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ]);
    expect(ix.data.length).toBe(8 + 32);
    expect(Buffer.from(ix.data.subarray(8)).equals(counterparty.toBuffer())).toBe(true);
  });
});
```

- [ ] **Step 2: Run, verify fail. Step 3: Write `src/instructions/migrateV5ToV6.ts`:**

```typescript
/**
 * migrate_v5_to_v6 — V5 (inline active_session) → V6 (per-counterparty PDAs).
 *
 * TWO instructions, picked by whether the V5 vault carries a LIVE (unexpired)
 * active_session:
 *  - none/expired → buildMigrateV5ToV6Instruction (vault shrinks; freed rent
 *    refunded to payer)
 *  - live → buildMigrateV5ToV6WithSessionInstruction (the live session is
 *    carried out into a NEW session PDA; liveCounterparty MUST equal the
 *    embedded active_session.allowed_counterparty or the handler reverts;
 *    payer funds the PDA rent — up-front, init runs before the handler —
 *    and receives the vault's shrink rent)
 *
 * Both are dexter_authority-gated. SDK 0.8.x cannot DECODE a V5 vault to make
 * the live-vs-none choice (the V5 reader was removed); callers migrating wild
 * V5 vaults decide via their own records, or try plain and fall back on
 * SessionAlreadyActive-style revert. No real V5 consumers exist as of
 * 2026-06-09 — these builders exist for completeness, not a live fleet.
 */
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { DEXTER_VAULT_PROGRAM_ID, DISCRIMINATORS } from '../constants/index.js';
import { deriveSessionPda } from '../session/index.js';

export interface MigrateV5ToV6Params {
  vaultPda: PublicKey;
  dexterAuthority: PublicKey;   // signer
  payer: PublicKey;             // signer, writable — receives the shrink rent
}

export function buildMigrateV5ToV6Instruction(p: MigrateV5ToV6Params): TransactionInstruction {
  return new TransactionInstruction({
    programId: DEXTER_VAULT_PROGRAM_ID,
    keys: [
      { pubkey: p.vaultPda, isSigner: false, isWritable: true },
      { pubkey: p.dexterAuthority, isSigner: true, isWritable: false },
      { pubkey: p.payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(DISCRIMINATORS.migrate_v5_to_v6),
  });
}

export interface MigrateV5ToV6WithSessionParams extends MigrateV5ToV6Params {
  /** Must equal the V5 vault's embedded active_session.allowed_counterparty. */
  liveCounterparty: PublicKey;
}

export function buildMigrateV5ToV6WithSessionInstruction(
  p: MigrateV5ToV6WithSessionParams,
): TransactionInstruction {
  const [sessionPda] = deriveSessionPda(p.vaultPda, p.liveCounterparty);
  return new TransactionInstruction({
    programId: DEXTER_VAULT_PROGRAM_ID,
    keys: [
      { pubkey: p.vaultPda, isSigner: false, isWritable: true },
      { pubkey: p.dexterAuthority, isSigner: true, isWritable: false },
      { pubkey: sessionPda, isSigner: false, isWritable: true },
      { pubkey: p.payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      Buffer.from(DISCRIMINATORS.migrate_v5_to_v6_with_session),
      p.liveCounterparty.toBuffer(),
    ]),
  });
}
```

- [ ] **Step 4: Add `export * from './migrateV5ToV6.js';` to `src/instructions/index.ts`. Run tests, expect pass. Step 5: Commit** — `git commit -m "feat(v6): migrate_v5_to_v6 builders (plain + with_session)"`

---

### Task 12: waitForSession — confirm-visibility (the lean-RPC lesson, encoded)

**Files:**
- Create: `src/session/wait.ts`
- Modify: `src/session/index.ts`
- Test: `tests/session.wait.test.ts`

Rationale: this session's mainnet run proved that on a lean RPC plan, "account exists" and even "version != 0" are STALE-BLIND after a REPLACE (read-your-writes lag) — the fix was content-aware waiting on the new session_pubkey. Consumers of the SDK will hit the identical race in production. Ship the cure in the library.

- [ ] **Step 1: Failing test** — `tests/session.wait.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { Connection, PublicKey } from '@solana/web3.js';
import { waitForSession } from '../src/session/index.js';
import type { SessionAccountState } from '../src/types.js';

const state = (version: number, pubkeyByte: number): SessionAccountState => ({
  address: 'x', version, bump: 1, vault: 'v',
  session: {
    sessionPubkey: new Uint8Array(32).fill(pubkeyByte),
    maxAmount: 1n, expiresAt: 4_000_000_000, allowedCounterparty: 'c', nonce: 0,
    spent: 0n, currentOutstanding: 0n, maxRevolvingCapacity: 1n,
    crystallizedCumulative: 0n, lastLockedSequence: 0,
  },
});

describe('waitForSession', () => {
  it('resolves only when the NEW session_pubkey is visible (not on stale data)', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(state(1, 1))   // stale: OLD session still visible
      .mockResolvedValueOnce(state(1, 2));  // fresh: NEW pubkey
    const s = await waitForSession(
      {} as Connection, PublicKey.unique(), PublicKey.unique(),
      { expectedSessionPubkey: new Uint8Array(32).fill(2), intervalMs: 1, timeoutMs: 1000, fetch },
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(s.session.sessionPubkey[0]).toBe(2);
  });

  it('cleared mode: resolves when version == 0', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(state(1, 1))
      .mockResolvedValueOnce(state(0, 0));
    const s = await waitForSession(
      {} as Connection, PublicKey.unique(), PublicKey.unique(),
      { cleared: true, intervalMs: 1, timeoutMs: 1000, fetch },
    );
    expect(s.version).toBe(0);
  });

  it('times out with a descriptive error', async () => {
    const fetch = vi.fn().mockResolvedValue(null);
    await expect(
      waitForSession({} as Connection, PublicKey.unique(), PublicKey.unique(),
        { expectedSessionPubkey: new Uint8Array(32).fill(9), intervalMs: 1, timeoutMs: 5, fetch }),
    ).rejects.toThrow(/waitForSession: timed out/);
  });
});
```

- [ ] **Step 2: Run, verify fail. Step 3: Write `src/session/wait.ts`:**

```typescript
/**
 * waitForSession — content-aware confirm-visibility for session writes.
 *
 * On rate-limited RPC, a read issued right after a confirmed register/revoke
 * can return STALE account data (read-your-writes lag). Existence and even
 * version != 0 are blind to a REPLACE (the old registration also satisfied
 * both). The reliable signal is CONTENT: the new session_pubkey (register) or
 * version == 0 (revoke). Mirrors waitForRole in ./tab/credit (the same race,
 * proven on mainnet 2026-06-09).
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { fetchSessionAccount } from './fetch.js';
import type { SessionAccountState } from '../types.js';

export interface WaitForSessionOpts {
  /** Register/replace mode: resolve when this exact pubkey is visible. */
  expectedSessionPubkey?: Uint8Array;
  /** Revoke mode: resolve when version == 0. */
  cleared?: boolean;
  intervalMs?: number;   // default 1000
  timeoutMs?: number;    // default 30_000
  fetch?: typeof fetchSessionAccount;
}

export async function waitForSession(
  connection: Connection,
  vault: PublicKey,
  allowedCounterparty: PublicKey,
  opts: WaitForSessionOpts,
): Promise<SessionAccountState> {
  const { expectedSessionPubkey, cleared, intervalMs = 1000, timeoutMs = 30_000 } = opts;
  if (!expectedSessionPubkey && !cleared) {
    throw new Error('waitForSession: pass expectedSessionPubkey (register) or cleared (revoke)');
  }
  const fetch = opts.fetch ?? fetchSessionAccount;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = await fetch(connection, vault, allowedCounterparty);
    if (s) {
      if (cleared && s.version === 0) return s;
      if (
        expectedSessionPubkey &&
        s.version !== 0 &&
        s.session.sessionPubkey.length === expectedSessionPubkey.length &&
        s.session.sessionPubkey.every((b, i) => b === expectedSessionPubkey[i])
      ) {
        return s;
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `waitForSession: timed out after ${timeoutMs}ms waiting for ` +
        (cleared ? 'cleared session' : 'new session_pubkey visibility'),
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
```

- [ ] **Step 4: Export from the barrel; run tests, expect pass. Step 5: Commit** — `git commit -m "feat(v6): waitForSession — content-aware confirm-visibility (read-your-writes cure)"`

---

### Task 13: exports, package entry, full gate

**Files:**
- Modify: `src/index.ts`, `package.json`, `tsup.config.ts` (if entries are explicit)

- [ ] **Step 1:** Add to `src/index.ts`: `export * from './session/index.js';` Add the subpath export to `package.json`:

```json
    "./session": {
      "types": "./dist/session/index.d.ts",
      "import": "./dist/session/index.js",
      "require": "./dist/session/index.cjs"
    },
```

Add the matching tsup entry if the config lists entries explicitly (`src/session/index.ts`).

- [ ] **Step 2: Full gate.** Run, in order, all must pass:

```bash
npm run typecheck      # zero errors
npm run build          # tsup clean
npx vitest run         # ENTIRE suite green — old + new
```

Any stragglers from the V5→V6 signature changes (other test files, `src/connect`, `src/factoring`, `src/counterfactual.ts`, `src/kit`) surface HERE — fix them, don't suppress. (Survey on 2026-06-09 found no session references in connect/factoring/counterfactual, so expected stragglers are test call sites only.)

- [ ] **Step 3: Commit** — `git commit -m "feat(v6): session subpath export + full-suite gate green"`

---

### Task 14: LIVE mainnet proof — SDK builders drive the full V6 lifecycle ⛔ CHECKPOINT

**Files:**
- Create: `~/websites/dexter-vault/tests/prove-sdk-v6.ts` (the dexter-vault repo owns the passkey/secp256r1 apparatus + the funded wallet + the throttled harness)

**GATE: costs real SOL (~0.05) + USDC dust + RPC credits. Get Branch's GO before running. Subagents NEVER run this; orchestrator only. RPC = the Helius key, NEVER mainnet-beta.**

- [ ] **Step 1: Point the local SDK at the build** — in dexter-vault: `npm install ~/websites/dexter-vault-sdk` (or re-symlink `node_modules/@dexterai/vault → ../dexter-vault-sdk`, the prove-sdk-credit pattern). Verify: `node -e "const s=require('@dexterai/vault/session'); console.log(typeof s.deriveSessionPda)"` → `function`.

- [ ] **Step 2: Write `tests/prove-sdk-v6.ts`.** Model: `tests/prove-sdk-credit.ts` (structure) + `tests/helpers/register-bootstrap.ts` (passkey leg). The test uses the dexter-vault harness ONLY for: provider/throttle, passkey signing (`signOperationWithPasskey`, `buildSecp256r1VerifyInstruction` from `tests/helpers/secp256r1.ts`), vault bootstrap (`bootstrapVault` with `migrateTo: 6`), and send/confirm (`sendRawAndConfirmHttp`). EVERY vault instruction + message + decode + wait comes from `@dexterai/vault`. Cases, in one mocha `describe` with `this.timeout(300_000)` per case:

```
1. register session A (counterparty CP_A) — SDK sessionRegisterMessage + SDK
   buildRegisterSessionKeyInstruction (siblings: SDK fetchVaultSessionAccounts → []),
   SDK waitForSession(expectedSessionPubkey). Assert SDK fetchSessionAccount:
   version 1, caps echo args.
2. register session B (CP_B) — siblings now [A] via SDK fetch. PROVES the sibling
   contract end-to-end through SDK code. waitForSession. Assert vault reader
   readVaultFull → liveSessionCount === 2.
3. readTabMeter(vault, CP_A) via SDK — assert {spent: 0, maxAmount, remaining}.
4. settle leg on A — SDK openTab (increment) then SDK settleTab (the full
   3-ix atomic: ed25519 precompile + settle_tab_voucher + SignV2 via SDK
   assembleSignV2). Assert SDK fetchSessionAccount: spent advanced by the
   voucher amount, currentOutstanding released.
5. revoke A — SDK sessionRevokeMessage over the PDA-read session_pubkey + SDK
   buildRevokeSessionKeyInstruction + passkey leg. SDK waitForSession(cleared).
   Assert liveSessionCount === 1.
6. REPLACE B — re-register CP_B with a new session keypair (siblings: fetch
   fresh → []), waitForSession(new pubkey). Assert meters RESET (spent 0).
```

Run command:

```bash
cd ~/websites/dexter-vault
ANCHOR_PROVIDER_URL="$SOLANA_RPC_URL" \
ANCHOR_WALLET="$HOME/.config/solana/dexter-vault/upgrade-authority.json" \
npx ts-mocha -p ./tsconfig.json -t 600000 tests/prove-sdk-v6.ts 2>&1 | tee /tmp/prove-sdk-v6.log
```

(Write full output to the file; do NOT pipe through `tail`. Poll completion with `pgrep -f "bin/mocha"`.)

- [ ] **Step 3: All 6 cases green.** Read the log: verify each case's assertions and tx signatures; record the signatures in the commit message. If a case fails: it's either an SDK bug (fix in dexter-vault-sdk, rebuild, rerun) or a known env-flake signature (429/WS-confirm — rerun the case). NEVER weaken an assertion to pass.

- [ ] **Step 4: Commit (both repos)**

```bash
cd ~/websites/dexter-vault && git add tests/prove-sdk-v6.ts && git commit -m "test(v6): prove-sdk-v6 — SDK builders drive the full multi-session lifecycle on mainnet"
```

---

### Task 15: docs + version + publish ⛔ GATED on Branch

**Files:**
- Modify: `package.json` (version), `README.md`, `CHANGELOG.md` (create if absent)

- [ ] **Step 1: CHANGELOG entry** — `0.8.0`: BREAKING — V6 multi-session. List: builders' new accounts/args (the table from this plan's ground-truth section, condensed), `ActiveSession` type + `VaultStateFull.activeSession` removed (and WHY: silent V6 mis-decode), `liveSessionCount` added, new `@dexterai/vault/session` subpath (derive/decode/fetch/wait), migration builders, tab-layer signatures gained `allowedCounterparty`. State plainly: 0.8.x targets V6 vaults only; mainnet-proven via prove-sdk-v6 (cite the tx signatures from Task 14).

- [ ] **Step 2: README** — update the session examples to the V6 flow (register with `fetchVaultSessionAccounts` → builder → `waitForSession`; the fetch-fresh + all-writable contract called out in a warning block).

- [ ] **Step 3: Version + publish — ONLY on Branch's explicit GO:**

```bash
npm version minor          # 0.7.0 → 0.8.0
npm publish --access public
```

Verify: `npm view @dexterai/vault@0.8.0 version` returns `0.8.0`; `npm view @dexterai/vault dist-tags`.

- [ ] **Step 4: Commit + push both repos. Update the PICKUP doc** (`dexter-thesis/architecture/PICKUP-2026-06-09-vault-v6-multisession.md`): SDK V6 sync DONE, leg 2 (spend grant) is next.

---

## Out of scope (tracked, do NOT drift into)

- **Leg 2** — `requestSpendGrant`/`approveSpendGrant` + frontend (next plan; reconcile against `dexter-thesis/.../specs/2026-06-07-connect-spend-grant.md`). The replace-warning UX (re-register OVERWRITES the tab for that counterparty) is leg-2's hard requirement — the SDK surfaces the primitive (`fetchSessionAccount` shows the existing tab) but the warning UI is leg 2.
- **Downstream consumers** — dexter-api / dexter-facilitator / dexter-mcp pin older SDK versions and keep working until deliberately upgraded; their upgrade is a separate effort (note it in the PICKUP doc).
- **`close_session`** rent reclaim — future program ix, no SDK work until it exists.
- **V5 vault decode helper** for migration triage — no wild V5 vaults exist; revisit only if one appears.

## Self-review notes (writing-plans checklist)

- Spec coverage: handoff §1 (Task 2-3), §2 (Task 4), §3 (Task 5), §4 (Tasks 6-8), §5 (Task 11), build-order item 1 (Tasks 1-13) — all mapped. Beyond-handoff items: reader corruption fix (Task 9), tab layer (Task 10), waitForSession (Task 12), live proof (Task 14), all-writable sibling policy (Task 3) — each with stated rationale.
- Placeholders: none — every code step shows code; Task 14's case list is a specification of assertions, with its reference implementations named.
- Type consistency: `SessionAccountState`/`SessionRegistrationState` defined once (Task 2), consumed in Tasks 3, 10, 12. `deriveSessionPda(vault, counterparty, programId?)` signature consistent across all uses.
