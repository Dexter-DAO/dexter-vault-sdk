# Thread B — V2/188 Session Registration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the off-chain client stack from V1/180-byte to V2/188-byte session registration so a real tab can open against the already-deployed mainnet program (which is V2/188).

**Architecture:** The `@dexterai/vault` SDK is the single source of truth for bytes the on-chain program verifies. The deployed program already speaks V2/188 (domain `OTS_SESSION_REGISTER_V2`, with a `max_revolving_capacity` u64 appended to both the signed registration message AND the `register_session_key` instruction args). The SDK is stale at V1/180. This plan fixes the bytes in `@dexterai/vault` (message builder + instruction builder + constants + parity test), bumps its version, then propagates to the two consumers: `@dexterai/x402`'s seller `verify.ts` (its parser/length-gate/domain) and `dexter-facilitator`'s one length constant. The byte-parity test is the red→green spec; a live mainnet tab open→settle is the final gate.

**Tech Stack:** TypeScript, `@solana/web3.js`, vitest (vault-sdk parity tests), the deployed Anchor program at `Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc`.

---

## AUTHORITATIVE SOURCE OF TRUTH (read before any task)

The deployed program's register handler is the contract every byte must match. From
`dexter-vault/programs/dexter-vault/src/instructions/register_session_key.rs`:

**Signed registration message (188 bytes)** — `build_registration_message`, lines 118-151:
```
[  0..32) domain  b"OTS_SESSION_REGISTER_V2\0\0\0\0\0\0\0\0\0"   (23 chars + 9 NUL)
[ 32..64) program_id
[ 64..96) vault_pda
[ 96..128) session_pubkey
[128..136) max_amount             u64 LE
[136..144) expires_at             i64 LE
[144..176) allowed_counterparty
[176..180) nonce                  u32 LE
[180..188) max_revolving_capacity u64 LE      <-- NEW (the only addition)
```

**Instruction args (Borsh order)** — `RegisterSessionKeyArgs`, lines 30-56. The Borsh
field order the program deserializes is EXACTLY:
```
session_pubkey: [u8;32]
max_amount: u64
expires_at: i64
allowed_counterparty: Pubkey (32)
nonce: u32
max_revolving_capacity: u64        <-- NEW: AFTER nonce, BEFORE the Vec<u8> fields
client_data_json: Vec<u8>
authenticator_data: Vec<u8>
```
The instruction builder's byte concatenation MUST insert `max_revolving_capacity` u64 LE
between `nonce` and `client_data_json` — get this position wrong and on-chain Borsh
deserialization fails.

**Program also enforces** (line 82): `require!(args.max_revolving_capacity > 0, VaultError::RevolvingCapacityZero)`.
So callers MUST pass a value > 0.

---

## FILE STRUCTURE (what each touched file is responsible for)

| File | Responsibility | Change |
|---|---|---|
| `dexter-vault-sdk/src/constants/index.ts` | Domain separators | Add `OTS_SESSION_REGISTER_V2_DOMAIN` |
| `dexter-vault-sdk/src/messages/session.ts` | The signed 188-byte message | 180→188 + append field + V2 domain |
| `dexter-vault-sdk/src/instructions/registerSession.ts` | The on-chain instruction data | Add `maxRevolvingCapacity` arg in Borsh order |
| `dexter-vault-sdk/tests/byte-parity.test.ts` | The spec (SDK==program) | Assert 188/V2 + new arg in ix data |
| `dexter-vault-sdk/package.json` | Version | Bump minor (0.3.5 → 0.4.0) |
| `dexter-x402-sdk/src/tab/seller/verify.ts` | Seller-side registration parse + gate | 180→188, V1→V2, parse new field |
| `dexter-facilitator/src/tabSettle.ts` | Inbound registration length floor | `REGISTRATION_MIN_LENGTH` 180→188 |

NOT touched (verified during survey):
- `dexter-x402-sdk/src/tab/messages.ts` — pure re-export shim of `@dexterai/vault/messages`; inherits the change for free.
- `dexter-x402-sdk` adapters/sessions/passkey-noble — they call the register builder by named args; once the builder gains an optional-then-required `maxRevolvingCapacity`, only call sites that build a registration need it (covered by Task 6's grep).

---

## Task 1: Add the V2 domain separator constant

**Files:**
- Modify: `dexter-vault-sdk/src/constants/index.ts:58-70` (the domain separators block)
- Test: `dexter-vault-sdk/tests/byte-parity.test.ts` (domain separators describe block)

- [ ] **Step 1: Write the failing test**

In `dexter-vault-sdk/tests/byte-parity.test.ts`, add to the `describe('domain separators', ...)` block (after the existing `OTS_SESSION_REVOKE_V1` test, around line 96):

```typescript
  test('OTS_SESSION_REGISTER_V2 is 32 bytes, 23-char label + 9 NUL', () => {
    expect(OTS_SESSION_REGISTER_V2_DOMAIN.length).toBe(32);
    // "OTS_SESSION_REGISTER_V2" is 23 chars
    const label = new TextDecoder().decode(OTS_SESSION_REGISTER_V2_DOMAIN.slice(0, 23));
    expect(label).toBe('OTS_SESSION_REGISTER_V2');
    for (let i = 23; i < 32; i++) {
      expect(OTS_SESSION_REGISTER_V2_DOMAIN[i]).toBe(0);
    }
  });
```

And add `OTS_SESSION_REGISTER_V2_DOMAIN` to the import on line 3:
```typescript
import { DISCRIMINATORS, OTS_SESSION_REGISTER_V1_DOMAIN, OTS_SESSION_REGISTER_V2_DOMAIN, OTS_SESSION_REVOKE_V1_DOMAIN } from '../src/constants/index.js';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dexter-vault-sdk && npx vitest run tests/byte-parity.test.ts -t "OTS_SESSION_REGISTER_V2"`
Expected: FAIL — `OTS_SESSION_REGISTER_V2_DOMAIN` is not exported (import error / undefined).

- [ ] **Step 3: Add the constant**

In `dexter-vault-sdk/src/constants/index.ts`, after the `OTS_SESSION_REGISTER_V1_DOMAIN` block (after line 64):

```typescript
export const OTS_SESSION_REGISTER_V2_DOMAIN: Uint8Array = (() => {
  const buf = new Uint8Array(32);
  buf.set(new TextEncoder().encode('OTS_SESSION_REGISTER_V2'), 0);
  return buf;
})();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dexter-vault-sdk && npx vitest run tests/byte-parity.test.ts -t "OTS_SESSION_REGISTER_V2"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd dexter-vault-sdk
git add src/constants/index.ts tests/byte-parity.test.ts
git commit -m "feat(vault-sdk): add OTS_SESSION_REGISTER_V2 domain separator"
```

---

## Task 2: Build the 188-byte V2 registration message

**Files:**
- Modify: `dexter-vault-sdk/src/messages/session.ts:17-59` (the args interface + builder)
- Test: `dexter-vault-sdk/tests/byte-parity.test.ts:101-115` (the `180-byte session registration` test)

- [ ] **Step 1: Update the failing test to expect 188/V2**

In `dexter-vault-sdk/tests/byte-parity.test.ts`, replace the `test('180-byte session registration', ...)` (lines 102-115) with:

```typescript
  test('188-byte V2 session registration', () => {
    const bytes = sessionRegisterMessage({
      programId: KNOWN_PROGRAM_ID,
      vaultPda: KNOWN_VAULT_PDA,
      sessionPubkey: KNOWN_SESSION_PUBKEY,
      maxAmount: 1_000_000n,
      expiresAt: 1735689600n,
      allowedCounterparty: KNOWN_COUNTERPARTY,
      nonce: 42,
      maxRevolvingCapacity: 2_000_000n,
    });
    expect(bytes.length).toBe(188);
    expect(bytes.subarray(0, 32)).toEqual(OTS_SESSION_REGISTER_V2_DOMAIN);
    // max_revolving_capacity at [180..188) LE
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getBigUint64(180, true)).toBe(2_000_000n);
    expect(bytes).toMatchSnapshot();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dexter-vault-sdk && npx vitest run tests/byte-parity.test.ts -t "188-byte V2 session registration"`
Expected: FAIL — `sessionRegisterMessage` does not accept `maxRevolvingCapacity` and returns 180 bytes.

- [ ] **Step 3: Update the message builder**

In `dexter-vault-sdk/src/messages/session.ts`:

Change the import (lines 12-15) to use the V2 domain:
```typescript
import {
  OTS_SESSION_REGISTER_V2_DOMAIN,
  OTS_SESSION_REVOKE_V1_DOMAIN,
} from '../constants/index.js';
```

Add `maxRevolvingCapacity` to the args interface (after `nonce: number;` on line 24):
```typescript
export interface SessionRegisterMessageArgs {
  programId: PublicKey;
  vaultPda: PublicKey;
  sessionPubkey: Uint8Array;       // 32 bytes
  maxAmount: bigint;
  expiresAt: bigint;
  allowedCounterparty: PublicKey;
  nonce: number;
  maxRevolvingCapacity: bigint;    // NEW — u64, must be > 0 (program enforces)
}
```

Replace the builder body (lines 40-59) — update the doc comment to 188, build 188 bytes, V2 domain, append the field:
```typescript
/**
 * 188-byte V2 session registration message. Layout:
 *    0   32  domain separator (OTS_SESSION_REGISTER_V2 + NUL padding)
 *   32   32  program_id
 *   64   32  vault_pda
 *   96   32  session_pubkey
 *  128    8  max_amount (u64 LE)
 *  136    8  expires_at (i64 LE)
 *  144   32  allowed_counterparty
 *  176    4  nonce (u32 LE)
 *  180    8  max_revolving_capacity (u64 LE)
 *                                    ────
 *                                    188
 */
export function sessionRegisterMessage(args: SessionRegisterMessageArgs): Uint8Array {
  if (args.sessionPubkey.length !== 32) {
    throw new Error(`sessionPubkey must be 32 bytes, got ${args.sessionPubkey.length}`);
  }
  const buf = new Uint8Array(188);
  const view = new DataView(buf.buffer);
  let o = 0;
  buf.set(OTS_SESSION_REGISTER_V2_DOMAIN, o); o += 32;
  buf.set(args.programId.toBytes(), o); o += 32;
  buf.set(args.vaultPda.toBytes(), o); o += 32;
  buf.set(args.sessionPubkey, o); o += 32;
  view.setBigUint64(o, args.maxAmount, true); o += 8;
  view.setBigInt64(o, args.expiresAt, true); o += 8;
  buf.set(args.allowedCounterparty.toBytes(), o); o += 32;
  view.setUint32(o, args.nonce >>> 0, true); o += 4;
  view.setBigUint64(o, args.maxRevolvingCapacity, true); o += 8;
  if (o !== 188) {
    throw new Error(`internal: session register message wrong length ${o}, expected 188`);
  }
  return buf;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dexter-vault-sdk && npx vitest run tests/byte-parity.test.ts -t "188-byte V2 session registration" -u`
(The `-u` writes the new snapshot — review the snapshot diff before committing.)
Expected: PASS, new snapshot written.

- [ ] **Step 5: Commit**

```bash
cd dexter-vault-sdk
git add src/messages/session.ts tests/byte-parity.test.ts tests/__snapshots__
git commit -m "feat(vault-sdk): sessionRegisterMessage builds 188-byte V2 (max_revolving_capacity)"
```

---

## Task 3: Add max_revolving_capacity to the register instruction builder

**Files:**
- Modify: `dexter-vault-sdk/src/instructions/registerSession.ts:64-91` (args interface + data concat)
- Test: `dexter-vault-sdk/tests/byte-parity.test.ts:180-192` (the `register_session_key` ix test)

- [ ] **Step 1: Update the failing test to pass + assert the new arg**

In `dexter-vault-sdk/tests/byte-parity.test.ts`, replace the `test('register_session_key', ...)` (lines 180-192) with:

```typescript
  test('register_session_key (V2 — carries max_revolving_capacity)', () => {
    const ix = buildRegisterSessionKeyInstruction({
      vaultPda: KNOWN_VAULT_PDA,
      sessionPubkey: KNOWN_SESSION_PUBKEY,
      maxAmount: 1_000_000n,
      expiresAt: 1735689600n,
      allowedCounterparty: KNOWN_COUNTERPARTY,
      nonce: 42,
      maxRevolvingCapacity: 2_000_000n,
      clientDataJSON: KNOWN_CLIENT_DATA,
      authenticatorData: KNOWN_AUTH_DATA,
    });
    // Borsh arg order: disc(8) + session_pubkey(32) + max_amount(8) + expires_at(8)
    //   + allowed_counterparty(32) + nonce(4) + max_revolving_capacity(8) + vecs...
    // max_revolving_capacity sits at offset 8+32+8+8+32+4 = 92, u64 LE.
    const data = new Uint8Array(ix.data);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    expect(view.getBigUint64(92, true)).toBe(2_000_000n);
    expect(data).toMatchSnapshot('register_session_key data');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dexter-vault-sdk && npx vitest run tests/byte-parity.test.ts -t "register_session_key"`
Expected: FAIL — `maxRevolvingCapacity` not accepted; offset 92 holds the wrong bytes (the old layout puts a Vec<u8> length there).

- [ ] **Step 3: Update the instruction builder**

In `dexter-vault-sdk/src/instructions/registerSession.ts`:

Update the doc comment Args list (lines 10-17) to insert `max_revolving_capacity: u64` after `nonce: u32`.

Add `maxRevolvingCapacity` to the args interface (after `nonce: number;` on line 70):
```typescript
export interface BuildRegisterSessionKeyArgs {
  vaultPda: PublicKey;
  sessionPubkey: Uint8Array;        // 32 bytes, ed25519
  maxAmount: bigint;
  expiresAt: bigint;                 // i64 seconds
  allowedCounterparty: PublicKey;
  nonce: number;                     // u32
  maxRevolvingCapacity: bigint;      // NEW — u64, must be > 0 (program enforces)
  clientDataJSON: Uint8Array;        // WebAuthn ceremony output
  authenticatorData: Uint8Array;     // WebAuthn ceremony output
}
```

Insert the encoded field into the `concatBytes` call (lines 82-91), AFTER `encodeU32LE(args.nonce)` and BEFORE `encodeVecU8(args.clientDataJSON)`:
```typescript
  const data = concatBytes(
    DISCRIMINATORS.register_session_key,
    args.sessionPubkey,
    encodeU64LE(args.maxAmount),
    encodeI64LE(args.expiresAt),
    args.allowedCounterparty.toBytes(),
    encodeU32LE(args.nonce),
    encodeU64LE(args.maxRevolvingCapacity),
    encodeVecU8(args.clientDataJSON),
    encodeVecU8(args.authenticatorData),
  );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dexter-vault-sdk && npx vitest run tests/byte-parity.test.ts -t "register_session_key" -u`
Expected: PASS, snapshot updated.

- [ ] **Step 5: Run the FULL parity suite (regression gate)**

Run: `cd dexter-vault-sdk && npx vitest run tests/byte-parity.test.ts`
Expected: ALL pass. (Confirms no other snapshot drifted.)

- [ ] **Step 6: Commit**

```bash
cd dexter-vault-sdk
git add src/instructions/registerSession.ts tests/byte-parity.test.ts tests/__snapshots__
git commit -m "feat(vault-sdk): register_session_key ix carries max_revolving_capacity (Borsh after nonce)"
```

---

## Task 4: Bump @dexterai/vault version

**Files:**
- Modify: `dexter-vault-sdk/package.json` (version field)

- [ ] **Step 1: Bump the version**

In `dexter-vault-sdk/package.json`, change `"version": "0.3.5"` to `"version": "0.4.0"`.
(Minor bump: additive-but-breaking-for-callers — registration callers MUST now pass `maxRevolvingCapacity`. The vault SDK is pre-1.0, so minor is the correct breaking-change channel.)

- [ ] **Step 2: Verify the build compiles**

Run: `cd dexter-vault-sdk && npm run build`
Expected: clean compile (the new required field is internal to this package; its own consumers are updated in Tasks 5-6).

- [ ] **Step 3: Commit**

```bash
cd dexter-vault-sdk
git add package.json
git commit -m "chore(vault-sdk): 0.4.0 — V2/188 session registration"
```

---

## Task 5: Update x402 seller verify.ts to parse V2/188

**Files:**
- Modify: `dexter-x402-sdk/src/tab/seller/verify.ts:36-134` (layout comment, domain const, parser)

- [ ] **Step 1: Write the failing test**

Create `dexter-x402-sdk/src/tab/seller/verify.v2.test.ts`:

```typescript
import { describe, test, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { sessionRegisterMessage } from '@dexterai/vault/messages';
import { parseRegistration, InvalidRegistrationError } from './verify';
import { DEXTER_VAULT_PROGRAM_ID } from '../instructions';

describe('parseRegistration V2/188', () => {
  const validBytes = () =>
    sessionRegisterMessage({
      programId: DEXTER_VAULT_PROGRAM_ID,
      vaultPda: new PublicKey('Sysvar1nstructions1111111111111111111111111'),
      sessionPubkey: new Uint8Array(32).fill(0xAA),
      maxAmount: 1_000_000n,
      expiresAt: BigInt(Math.floor(Date.now() / 1000) + 3600),
      allowedCounterparty: new PublicKey('Ed25519SigVerify111111111111111111111111111'),
      nonce: 42,
      maxRevolvingCapacity: 2_000_000n,
    });

  test('accepts a 188-byte V2 message and parses maxRevolvingCapacity', () => {
    const parsed = parseRegistration(validBytes());
    expect(parsed.maxAmount).toBe(1_000_000n);
    expect(parsed.maxRevolvingCapacity).toBe(2_000_000n);
    expect(parsed.nonce).toBe(42);
  });

  test('rejects a 180-byte (V1) message as wrong_length', () => {
    const short = validBytes().slice(0, 180);
    expect(() => parseRegistration(short)).toThrow(InvalidRegistrationError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dexter-x402-sdk && npx vitest run src/tab/seller/verify.v2.test.ts`
Expected: FAIL — `parseRegistration` rejects 188 as `wrong_length` (still gated to 180); `maxRevolvingCapacity` absent from `ParsedRegistration`.

(Note: this test imports `sessionRegisterMessage` from `@dexterai/vault` — ensure x402's installed `@dexterai/vault` is the 0.4.0 build. If x402 consumes a published tarball, run `npm install` after Task 4 publishes, OR `npm link ../dexter-vault-sdk` for local dev. If the import fails to resolve 0.4.0, that's the version-pin gate — see Task 7.)

- [ ] **Step 3: Update verify.ts**

In `dexter-x402-sdk/src/tab/seller/verify.ts`:

Update the layout comment (lines 36-48) to the 188-byte V2 layout (domain `_V2`, add the `180 8 max_revolving_capacity` row, total 188).

Change the domain prefix constant (line 50):
```typescript
const REGISTER_DOMAIN_PREFIX = 'OTS_SESSION_REGISTER_V2';
```

Add `maxRevolvingCapacity` to the `ParsedRegistration` interface (after `nonce: number;` on line 59):
```typescript
export interface ParsedRegistration {
  programId: PublicKey;
  vaultPda: PublicKey;
  sessionPubkey: Uint8Array;        // 32 bytes
  maxAmount: bigint;
  expiresAt: bigint;                // unix seconds
  allowedCounterparty: PublicKey;
  nonce: number;
  maxRevolvingCapacity: bigint;     // NEW — u64 at [180..188)
}
```

Change the length gate (line 83):
```typescript
  if (registration.length !== 188) {
    throw new InvalidRegistrationError('wrong_length', `expected 188, got ${registration.length}`);
  }
```

Parse the new field — after `const nonce = view.getUint32(176, true);` (line 106), add:
```typescript
  const maxRevolvingCapacity = view.getBigUint64(180, true);
```

Add it to the returned object (lines 125-133):
```typescript
  return {
    programId,
    vaultPda,
    sessionPubkey: new Uint8Array(sessionPubkey),
    maxAmount,
    expiresAt,
    allowedCounterparty,
    nonce,
    maxRevolvingCapacity,
  };
```

Also fix the now-stale `readVaultState` comment (lines 220-227): the on-chain
`SessionRegistration` layout after `spent: u64` now continues
`current_outstanding: u64` then `max_revolving_capacity: u64`. Append those two lines to
that comment block so the next reader isn't misled. (Functional code unchanged — it only
reads `session_pubkey`, the first field, so the offset math at line 227 stays correct.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dexter-x402-sdk && npx vitest run src/tab/seller/verify.v2.test.ts`
Expected: PASS — both tests green.

- [ ] **Step 5: Run the existing verify tests (regression)**

Run: `cd dexter-x402-sdk && npx vitest run src/tab/seller/`
Expected: any pre-existing verify tests that built V1/180 fixtures will now fail on the
180→188 change. If such a fixture exists, update it to build via `sessionRegisterMessage`
with `maxRevolvingCapacity` (don't hand-roll 180-byte literals). If none exist, all pass.

- [ ] **Step 6: Commit**

```bash
cd dexter-x402-sdk
git add src/tab/seller/verify.ts src/tab/seller/verify.v2.test.ts
git commit -m "feat(x402): seller verify.ts parses V2/188 registration (max_revolving_capacity)"
```

---

## Task 6: Sweep x402 + facilitator for remaining V1/180 call sites

**Files:**
- Inspect: all of `dexter-x402-sdk/src/tab/`
- Modify: `dexter-facilitator/src/tabSettle.ts:104` (`REGISTRATION_MIN_LENGTH`)
- Modify: any x402 call site that builds a registration (found via grep below)

- [ ] **Step 1: Grep x402 for register-building call sites + lingering 180/V1**

Run:
```bash
cd dexter-x402-sdk && grep -rnE "buildRegisterSessionKeyInstruction|sessionRegisterMessage|\b180\b|REGISTER_V1|maxRevolvingCapacity" src/tab/ | grep -v ".test.ts"
```
Expected: a short list. For EACH call site that builds a registration message or the
register instruction, confirm it now passes `maxRevolvingCapacity`. (TypeScript will have
already flagged any that don't — the field is required as of Task 2/3. This grep is the
belt-and-suspenders pass.) Any that build a registration but lack the field: add it,
threading the value from that call site's own config/args (do NOT hardcode a literal —
plumb it from the same place `maxAmount` comes from).

- [ ] **Step 2: Type-check x402 to surface any missed call site**

Run: `cd dexter-x402-sdk && npx tsc --noEmit`
Expected: zero errors. A `maxRevolvingCapacity is missing` error pinpoints any call site
the grep missed — fix each by plumbing the value through.

- [ ] **Step 3: Update the facilitator length floor**

In `dexter-facilitator/src/tabSettle.ts`, change line 104:
```typescript
const REGISTRATION_MIN_LENGTH = 188;
```
(This is a lower-bound sanity gate that only reads the vault PDA at offset 64 — it does
NOT parse the new field and does NOT build a registration, so this single constant is its
entire blast radius. Confirmed during survey.)

- [ ] **Step 4: Type-check the facilitator**

Run: `cd dexter-facilitator && npx tsc --noEmit`
Expected: zero NEW errors from this change. (The repo has pre-existing uncommitted work in
`internalSign.ts` / config — do NOT touch those; only assess errors attributable to line 104.)

- [ ] **Step 5: Commit (two repos, two commits)**

```bash
cd dexter-x402-sdk
git add -A src/tab/
git commit -m "fix(x402): thread maxRevolvingCapacity through tab register call sites"

cd ../dexter-facilitator
git add src/tabSettle.ts
git commit -m "fix(facilitator): registration min length 180->188 (V2)"
```

---

## Task 7: Resolve the @dexterai/vault version pin in x402

**Files:**
- Modify: `dexter-x402-sdk/package.json` (the `@dexterai/vault` dependency)

**Context:** x402 currently declares `@dexterai/vault ^0.1.3` but source is now 0.4.0. The
consumers in Tasks 5-6 need the 0.4.0 byte builders. This task makes x402 actually resolve
0.4.0.

- [ ] **Step 1: Determine the consumption model**

Run: `cd dexter-x402-sdk && npm ls @dexterai/vault 2>/dev/null; cat node_modules/@dexterai/vault/package.json | grep '"version"'`
This shows what version is currently installed. Decide:
- If `@dexterai/vault` is published to a registry: publish 0.4.0 first (`cd dexter-vault-sdk && npm publish`), then bump x402's dependency to `^0.4.0` and `npm install`.
- If it's consumed via local link / file path / workspace: re-link or rebuild so x402 picks up the local 0.4.0.

**STOP and report to Branch which model is in use before publishing anything to a public
registry** — publishing is an outward-facing, hard-to-reverse action requiring explicit
authorization (same class as a mainnet deploy).

- [ ] **Step 2: Update the dependency declaration**

In `dexter-x402-sdk/package.json`, change `"@dexterai/vault": "^0.1.3"` to `"^0.4.0"`
(only after 0.4.0 is resolvable per Step 1's decision).

- [ ] **Step 3: Install + verify resolution**

Run: `cd dexter-x402-sdk && npm install && npm ls @dexterai/vault`
Expected: resolves to 0.4.0.x.

- [ ] **Step 4: Re-run the x402 V2 test against the real dependency**

Run: `cd dexter-x402-sdk && npx vitest run src/tab/seller/verify.v2.test.ts`
Expected: PASS — now exercising the real 0.4.0 `sessionRegisterMessage` (188 bytes).

- [ ] **Step 5: Commit**

```bash
cd dexter-x402-sdk
git add package.json package-lock.json
git commit -m "chore(x402): bump @dexterai/vault to ^0.4.0 (V2/188 registration)"
```

---

## Task 8: THE GATE — verify a real tab open→settle on mainnet

This is the definition of done for Thread B: the updated client stack must successfully
open and settle a real tab against the deployed mainnet program. Parity tests prove the
bytes match in isolation; this proves the whole path works end to end.

**Files:**
- Inspect/use: `dexter-vault/tests/register-session-key.ts` (currently V1/180 — pre-existing tsc error) or a fresh harness
- Reference: `dexter-vault/tests/revolving-meter.ts` (`registerSettleableVault` already does V2/188 register on mainnet — proven working in the turnover demo)

- [ ] **Step 1: Confirm an existing V2 mainnet path already works**

The credex turnover demo (`dexter-vault/tests/revolving-meter.ts`) ALREADY registers a
V2/188 session on mainnet via `registerSettleableVault` and settles 10 tabs — it passed
(vault `3Af4F7vH...`). That proves the PROGRAM side. Task 8 proves the SDK side: that the
SAME flow works when driven by the updated `@dexterai/vault` 0.4.0 + x402 builders, not the
in-test helpers.

Run the existing proof to confirm the baseline is still green:
```bash
cd dexter-vault && npm run prove:credex
```
Expected: `*** CREDEX PROOF: settled=$10 capacity=$2 turnover=5x ***`, exit 0.
(~7 min, ~0.05-0.1 SOL, mainnet. Wallet: `~/.config/solana/dexter-vault/upgrade-authority.json`.)

- [ ] **Step 2: Fix dexter-vault/tests/register-session-key.ts to V2/188**

This test builds a V1/180 registration ceremony and has a pre-existing tsc error. Update it
to use the 0.4.0 `buildRegisterSessionKeyInstruction` + `sessionRegisterMessage` with
`maxRevolvingCapacity` (mirror the working ceremony in `revolving-meter.ts`'s
`registerSessionWithCapacity` helper). Make it type-check.

Run: `cd dexter-vault && npx tsc --noEmit -p tsconfig.json 2>&1 | grep register-session-key`
Expected: no errors referencing `register-session-key.ts`.

- [ ] **Step 3: Run the register-session-key test on mainnet**

Run:
```bash
cd dexter-vault && \
ANCHOR_WALLET=$HOME/.config/solana/dexter-vault/upgrade-authority.json \
ANCHOR_PROVIDER_URL=https://api.mainnet-beta.solana.com \
npx ts-mocha -p ./tsconfig.json -t 600000 tests/register-session-key.ts
```
Expected: PASS — a V2/188 registration, built by the updated SDK path, is accepted by the
live program (passkey signature verifies against the 188-byte message). Node fetch needs
sandbox disabled (curl works under sandbox; fetch does not) — use `dangerouslyDisableSandbox`
for the mainnet RPC calls.

- [ ] **Step 4: Commit**

```bash
cd dexter-vault
git add tests/register-session-key.ts
git commit -m "test(vault): register-session-key ceremony to V2/188 — green on mainnet"
```

- [ ] **Step 5: Report Thread B GREEN**

Thread B is complete when: all vault-sdk parity tests pass, x402 resolves 0.4.0 and its V2
test passes, the facilitator type-checks, and a V2/188 registration is accepted by the live
mainnet program. This is the gate that unblocks Phase 1 / LockedClaim end-to-end testing.

---

## DISCIPLINE REMINDERS (apply to every task / subagent)

- **HARD no-deploy fence:** YOU MAY RUN `anchor build`, `npm run build`, `tsc`, `vitest`,
  `ts-mocha`. YOU MAY NOT RUN `anchor deploy`, `anchor upgrade`, `solana program deploy`, OR
  ANY CHAIN-WRITING PROGRAM DEPLOY. The program is already deployed and correct — Thread B
  changes NO Rust program code. If a task seems to need a deploy, STOP and report BLOCKED.
- **npm publish is outward-facing:** Task 7 may require publishing `@dexterai/vault`. STOP
  and get Branch's explicit go before any `npm publish` — it's hard-to-reverse and public.
- **Mainnet test runs cost real SOL** (Tasks 1-7 are all build/type-check/unit — NO mainnet.
  Only Task 8 touches mainnet). Wallet has ~2.4 SOL.
- **Tests run on MAINNET where secp256r1 is involved** (the precompile is mainnet-only; there
  is NO local validator path — settled, do not relitigate). Node fetch needs sandbox disabled.
- **Do NOT touch Branch's uncommitted work:** dexter-facilitator has uncommitted
  `internalSign.ts` / config / docs; dexter-x402-sdk has an untracked research doc. Leave them.
- **Commit per task. Do not push** until Branch says so (same as the credex commits).

---

## SELF-REVIEW NOTES (author's check against the program contract)

- **Spec coverage:** message 188/V2 (T2), instruction arg in Borsh order (T3), domain (T1),
  parity spec (T1-3), consumer parse (T5), facilitator floor (T6), version pin (T7), live
  gate (T8). Every byte-surface the program touches is covered.
- **Type consistency:** `maxRevolvingCapacity: bigint` used identically in
  `SessionRegisterMessageArgs` (T2), `BuildRegisterSessionKeyArgs` (T3), `ParsedRegistration`
  (T5). The on-chain field is `max_revolving_capacity: u64` — `bigint` is the correct TS
  mirror (matches `maxAmount`/`spent` which are also u64→bigint in this SDK).
- **Borsh offset proof (T3 Step 1):** disc 8 + session_pubkey 32 + max_amount 8 + expires_at 8
  + counterparty 32 + nonce 4 = 92. So `max_revolving_capacity` u64 starts at byte 92. Matches
  the test's `view.getBigUint64(92, true)`.
- **The one human-gated decision:** Task 7 Step 1 (publish vs link) — flagged for Branch, not
  assumed.
