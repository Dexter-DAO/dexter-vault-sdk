# @dexterai/vault — SDK Deep Audit & Master Redesign

**Date:** 2026-06-07
**Package audited:** `@dexterai/vault@0.4.2`
**Author:** Lead SDK architect (synthesis of 2 capability lenses + adversarial critique, re-verified against source)
**Status:** definitive recommendation — every claim below was checked against the actual source tree in `/home/branchmanager/websites/dexter-vault-sdk` and the four live consumer repos.

---

## 1. EXECUTIVE VERDICT

**What this SDK is today:** a byte-precise *parts box*. It hands you ~44 low-level primitives — one builder per on-chain instruction, message encoders, precompile helpers, PDA derivers, signers — so any TypeScript service can produce bytes the dexter-vault program will accept without hand-laying them out. That is a real, valuable thing, and **four production services already depend on it** (dexter-api, dexter-facilitator, dexter-x402-sdk, dexter-fe).

**What's wrong with it:** the one capability that makes Dexter *Dexter* — the revolving-credit loop (open a tab, stream micro-charges, settle, the meter refusing an overspend) — is **not in the package at all**. It is hand-reassembled inside the facilitator (`dexter-facilitator/src/tabSettle.ts`), copy-pasted against the program's own tests and against the SDK's own `factoring/instantPayout.ts`. The SDK was created to kill byte-level drift across repos; it succeeded at the byte level and then *recreated the exact same drift one layer up*, at the composition level. Separately, the README is roughly two program tiers stale (it documents 12 discriminators / a 180-byte session message; the code ships 20 discriminators / a 188-byte V2 message), and the "byte-parity" test that is the SDK's entire reason to exist is currently a tautology — it pins constants against copies of themselves, not against the deployed program.

**What it should become:** the *same parts box, plus a thin composed-instruction layer on top*. Not a replacement — an addition. Promote the proven facilitator loop into a first-class `./tab` subpath that returns correctly-ordered, injectable `TransactionInstruction[]` (the exact shape `instantPayout.ts` already proved), keep every primitive public, fix the staleness, and make the parity test actually verify against the program. This is additive and breaks nobody.

---

## 2. THE CORE PROBLEM — parts-box vs product, and the stranded loop

### The anchor finding (verified)

The decisive fact, checked against source: **the loop orchestration already exists — but as a private copy inside one server.**

`dexter-facilitator/src/tabSettle.ts` (21,639 bytes) is the "missing" orchestration layer both lenses claim doesn't exist. It:

- imports the SDK parts — `readVaultFull` (`/reader`), `buildSettleTabVoucherInstruction` (`/instructions`), `buildEd25519VerifyInstruction` (`/precompile`) — verified at `tabSettle.ts:73-75`;
- hand-assembles the full atomic settle: Ed25519 precompile + `settle_tab_voucher` + Swig `getSignInstructions` SignV2 (`tabSettle.ts:323-408`);
- does the **cumulative-delta meter math itself**: `transferAmount = cumulativeAmount - active.spent` (`tabSettle.ts:367`);
- enforces **overspend refusal off-chain** before it touches the chain: `non_monotonic_cumulative` / `cumulative_exceeds_session_cap` (`tabSettle.ts:286-293`), against freshly-read on-chain state via `readVaultFull` (`:250`);
- runs the kit→web3 bridge inline.

So the real defect is **not** that orchestration is impossible. It is that orchestration is **copy-pasted** across consumers and the program tests — the precise drift problem the SDK was created to eliminate. The package README's own pitch (README:28): *"Three repos used to hand-roll these primitives and one of them missed a role; that bug is now structurally impossible."* True at the byte level. **Untrue at the composition level**, where the 3-instruction atomic tab settle is now hand-rolled in at least three places (facilitator, program tests, and partially mirrored by `factoring/instantPayout.ts`).

### Why the "parts box" framing is half-right

The what-it-does lens is correct that ~44 of ~48 exports are PARTS and only ~4–6 are PRODUCT-shaped. But the critique's correction holds and is verified: **the actual consumers are servers that WANT the parts.** dexter-api imports `buildSetSwigAtomicFromIdentity` *directly* (`dexter-api/src/vault/firstUseBundle.ts:34,170`); dexter-x402-sdk *re-exports* SDK constants and precompile builders by name (`dexter-x402-sdk/src/tab/index.ts:64-90`, re-exporting `buildSecp256r1VerifyInstruction`, `DEXTER_VAULT_PROGRAM_ID`, `SECP256R1_PROGRAM_ID`, etc.). These services own fee-payer, signing, RPC, and compute budget; they need instruction arrays so they can batch, inject policy, and choose the signer. The empirical claim "no consumer wants a `TransactionInstruction[]`" is **false for the current buyers.**

**Therefore the answer is not parts-box OR product. It is parts-box AND a composed layer on top.** The product gap is real, but only for a browser / third-party consumer and for *eliminating the facilitator's private copy* — not for the servers' day-to-day use of primitives.

---

## 3. THE IDEAL SHAPE — the target public API

### 3.1 Altitude (the single most important decision)

The composed layer returns **assembled, correctly-ordered `TransactionInstruction[]` with the Swig SignV2 already composed and an INJECTABLE assembler** — it does **NOT** build+sign+send+confirm.

This is the altitude `factoring/instantPayout.ts` already proved (verified, full file read):

- `buildInstantPayoutInstructions(params): Promise<TransactionInstruction[]>` (`instantPayout.ts:61`)
- composition behind an injectable `assembleSignV2?` (`:58`, `:84`) so it is **unit-testable without live Swig state** — the default wires real `@swig-wallet/kit` (`:97-127`)
- returns `[settleIx, ...signV2Ixs]` — instructions, not a sent transaction (`:93`)
- caller still owns `feePayer`, `connection`, compute budget, send/confirm

Sign+send+confirm is the wrong altitude and would *fork the codebase*: the facilitator injects its own fee payer, compute budget, and Helius sender; a send-verb would be unusable by it and by dexter-api. **Orchestrate the instruction composition (right); do not own the transaction lifecycle (wrong for a server-consumed SDK).**

### 3.2 The new high-level surface: `@dexterai/vault/tab`

A new subpath that ports `tabSettle.ts` + the revolving-meter behavior into reusable, injectable builders. Proposed verbs (all return `TransactionInstruction[]` or a small composed result, all injectable):

```ts
// open a tab — raise current_outstanding (settle_voucher increment leg)
openTab(params: {
  vaultPda: PublicKey;
  swigAddress: PublicKey;
  amount: bigint;
  // ...session/channel identity
}): TransactionInstruction[]

// stream + settle-close a micro-charge — the 3-ix atomic leg
//   [N-1] Ed25519 precompile over the 44-byte voucher (channel_id || cumulative_u64 || sequence_u32)
//   [N]   settle_tab_voucher  (monotonic + cap validated on-chain)
//   [N+1] swig::SignV2(TransferChecked)  for the delta = cumulative - priorSpent
settleTab(params: {
  connection: Connection;
  vaultPda: PublicKey;
  swigAddress: PublicKey;
  channelId: Uint8Array;
  cumulativeAmount: bigint;
  sequenceNumber: number;
  sessionSigner: SessionSigner;   // use the SDK's existing ./signers interface
  mint: PublicKey;
  sellerAta: PublicKey;
  feePayer: PublicKey;
  assembleSignV2?: AssembleSignV2; // injectable, exactly like instantPayout
}): Promise<TransactionInstruction[]>

// a READ-ONLY capacity reporter (NOT a refuser — see §6)
readTabMeter(connection, vaultPda): Promise<{
  spent: bigint;
  currentOutstanding: bigint;
  maxRevolvingCapacity: bigint;
  remaining: bigint;
}>
```

The credit twin (`open_standby` → `draw_credit` → `repay_credit`/`seize_collateral`) is the same shape and gets the same treatment — `drawCredit()` composes the atomic vault ix + financier-swig SignV2 to seller, identical to the tab settle. Ship it in the same `./tab` (or a sibling `./credit`) subpath.

**Crucially:** the cumulative-delta math (`cumulative - priorSpent`) and the precompile/marker ordering knowledge — which today live ONLY in `tabSettle.ts:367` and the program tests — move INSIDE these builders. That ordering knowledge is literally the README's stated reason the SDK exists; right now the fix lives outside the SDK.

### 3.3 What stays as primitives underneath (unchanged, still public)

Everything currently exported stays exported. The `./tab` verbs are built *on top of* the primitives, not instead of them:

- all 20+ `buildXInstruction` builders (`./instructions`)
- all message encoders (`./messages`) — `sessionRegisterMessage`, `voucherPayloadMessage`, etc.
- precompile builders (`./precompile`)
- PDA derivers (`./counterfactual`)
- `DISCRIMINATORS`, domain tags, program IDs (`./constants`) — **this is the byte-parity surface and the entire product; never hide it**
- readers (`./reader`), signers (`./signers`, `./signers/node`, `./signers/browser`)
- `./factoring` (the existing precedent)

### 3.4 Proposed exports map

```jsonc
"./tab":     { "types": "./dist/tab/index.d.ts",    "import": "./dist/tab/index.js",    "require": "./dist/tab/index.cjs" },
// (optional sibling, or fold credit into ./tab)
"./credit":  { "types": "./dist/credit/index.d.ts", "import": "./dist/credit/index.js", "require": "./dist/credit/index.cjs" }
```

Everything else in the current `exports` map stays byte-for-byte identical. No existing entry is removed, renamed, or restructured.

### 3.5 Package strategy: ADD a subpath, do NOT rename — recommendation with reasoning

**Recommendation: additive `@dexterai/vault/tab` subpath inside the existing package. Do NOT create a separate `@dexterai/tab` package, and do NOT rename anything.**

Reasoning:

1. **Blast radius.** This is a published `0.x` package that four repos import *by subpath*. A new package would force every consumer to add a dependency, re-wire imports, and keep two packages' versions in lockstep (the `./tab` layer depends on the same constants/instructions, so a split creates a cross-package version coupling that is worse than a monorepo subpath).
2. **Cohesion.** The tab layer is *literally* composed from the same `DISCRIMINATORS`, the same `settle_tab_voucher` builder, the same precompile. Splitting it out means either duplicating those (drift again) or making `@dexterai/tab` depend on `@dexterai/vault` (a thin wrapper package — pure overhead).
3. **The precedent already chose this.** `./factoring` is exactly this pattern: a composed-instruction layer shipped as a subpath of the same package. `./tab` is its sibling. Consistency.
4. **SemVer.** Adding a subpath is a **minor** bump under SemVer-for-0.x convention the changelog already follows ("This is additive; prior consumers continue to work unchanged"). It is the lowest-risk way to ship a new capability.

A rename (`@dexterai/vault` → anything) is the single highest-blast-radius move available and buys nothing.

---

## 4. CORRECTNESS / STALENESS FIXES — severity-ranked vs the deployed V5 program

> Ground-truth counts verified in source: `src/constants/index.ts` exports **20** discriminators (`initialize_vault` … `migrate_v4_to_v5`); `src/messages/session.ts` builds a **188-byte V2** session message (`:46`, `:58`). Both lenses miscounted (one said 22, README says 12) — cite **20** and **188**.

### S0 — CRITICAL: the byte-parity guarantee is a tautology, not a parity check

The SDK's whole pitch (README) is byte-parity so on-chain bytes can't drift. But `tests/byte-parity.test.ts` pins each discriminator against a **copy of the same literal**:

```ts
expect(DISCRIMINATORS.settle_tab_voucher).toEqual(
  Uint8Array.from([173, 22, 98, 31, 110, 129, 59, 161]),   // ← same bytes as the constant
);
```

This proves the constant equals itself. It does **not** verify against the deployed program. The changelog even admits the new tiers are pinned "against hardcoded literals." A discriminator is `sha256("global:<ix_name>")[..8]` — the test should **compute** that (or read the bundled `src/idl/dexter_vault.json`, which is already shipped) and assert the constant matches the *derived* value. As written, a fat-fingered constant that matches its own typo'd snapshot passes green. **This is the one dimension where the SDK's core promise can silently fail. Fix first.**
*Fix:* add a parity test that derives discriminators from `sha256("global:"+name)` and/or cross-checks `DISCRIMINATORS` against `idl/dexter_vault.json`. Doc-only-adjacent in effort, but it is the load-bearing guarantee.

### S1 — HIGH: README documents program v2 while code targets V5

- README:28 / :146 / :168 say **180-byte** session message — code ships **188-byte V2** (`session.ts:46`).
- README:187 says **12 discriminators** — code ships **20**.
- README:232 calls `BrowserPasskeySigner` "the v0.2 work" (unshipped) — `WebAuthnAssertion` **shipped in 0.2.0** and lives at `./signers/browser`.
- README has **zero** mention of: credit tier, lockedClaim tier, factoring, `migrate_v4_to_v5`, the V5 program, the revolving meter, or any open/stream/settle narrative.

A developer reading the README cannot even enumerate the parts box correctly, let alone find the product. Frame the rewrite as: *"README documents program v2; code targets the V5 program with credit + lockedClaim + factoring tiers and the revolving meter."*

### S2 — HIGH: the demoable product is invisible

The single most differentiating artifact Dexter has — the 5× turnover, overspend-refusing revolving meter (the bakeoff marketing hook, per MEMORY) — is mainnet-proven but documented nowhere in the package. Anyone evaluating `@dexterai/vault` on npm sees instruction primitives, not the product. (Fixed for real by §3's `./tab` + a README capability section.)

### S3 — MEDIUM: security/key-handling surface has un-audited footguns

No lens looked here; for an "unruggable" vault SDK this is the biggest blind spot.

- README quick-start (`:58`, `:121`) puts `hmacKey: serverSecret.subarray(0, 32)` front and center — a `subarray` is a **view**, not a copy, so a caller who later zeroes/mutates `serverSecret` silently corrupts the key. Document the copy semantics or hand back a copy.
- `derSignatureToCompactLowS` does low-S normalization — the classic home of malleability bugs. It has DER tests; keep them, and add a malleability/round-trip property test.
- V1/V2 session domain tags (`OTS_SESSION_REGISTER_V1/V2`, revoke) and `channel_id` reuse are a wrong-domain-tag footgun surface. Add a test that the V1 and V2 register messages are non-interchangeable.

### S4 — LOW: drift the SDK could absorb but hasn't

`kitInstructionsToWeb3` is duplicated across 3+ program test files **and** `factoring/kitBridge.ts`. The `./tab` work should import the SDK's bridge, not re-copy it — and the program tests should too, once `./tab` exists.

---

## 5. THE RESHAPE PLAN — ordered steps, today's parts-box → ideal shape

Tags: **[NET-NEW]** new code · **[LIFT]** promote proven code from facilitator/tests · **[DOC]** documentation only.

1. **[DOC] [S0] Make byte-parity real.** Rewrite `tests/byte-parity.test.ts` to derive discriminators from `sha256("global:<name>")` and/or cross-check against the bundled `idl/dexter_vault.json`. This is the guarantee the whole package sells; fix it before adding surface. *(Effort: small. Blast radius: zero — tests only.)*

2. **[LIFT] Create `src/tab/` by porting `tabSettle.ts`.** This is the promotion of the proven facilitator loop to first-class. Copy the 3-instruction atomic composition and the `cumulative - priorSpent` delta math (`tabSettle.ts:323-408`, `:367`) into `settleTab()`, refactored to the `instantPayout.ts` shape: take `connection` + injectable `assembleSignV2` + a `SessionSigner` (the SDK already defines this under `./signers`), return `TransactionInstruction[]`, **do not send**. Strip the Anchor/`AnchorProvider` binding the program-test helpers carry. *(Mostly LIFT, some NET-NEW glue. This is where the proven loop becomes importable.)*

3. **[NET-NEW] Add `openTab()` + `readTabMeter()`.** `openTab` wraps the `settle_voucher` increment leg; `readTabMeter` is a thin reporter over `readVaultFull` returning `{spent, currentOutstanding, maxRevolvingCapacity, remaining}`. Report-only — it does NOT refuse (see §6). *(Small NET-NEW.)*

4. **[LIFT] Add the credit twin** (`drawCredit`, etc.) the same way, from the credit lifecycle tests + `tabSettle` pattern. Fold into `./tab` or a sibling `./credit`. *(LIFT.)*

5. **[NET-NEW] Wire the exports map** — add `./tab` (and optional `./credit`) per §3.4. Update `tsup.config.ts` entry points. Nothing removed. *(Trivial.)*

6. **[NET-NEW] Unit tests for `./tab`** using the injectable assembler — prove open→stream→settle composition and instruction ordering *without live Swig*, exactly as `factoring.instantPayout.test.ts` does today. Add the overspend-*reporting* assertion. *(NET-NEW, but the test pattern is already proven in the factoring tests.)*

7. **[LIFT] Cut the facilitator over to `./tab`.** Replace `tabSettle.ts`'s hand-assembly with the new SDK verbs (it keeps owning fee payer / compute budget / Helius send — the SDK returns instructions, facilitator sends them). **This is the payoff: the private copy is deleted, drift is killed at the composition level.** Also point the program tests at the SDK's `kitBridge` (S4). *(LIFT / deletion.)*

8. **[DOC] [S1/S2/S3] Rewrite the README** around capabilities: 20 discriminators, 188-byte V2 session, shipped `WebAuthnAssertion`, the credit/lockedClaim/factoring tiers, and a front-and-center open→stream→settle / 5× turnover narrative. Fix the `subarray` copy-semantics note. *(DOC.)*

9. **[DOC] Cut a minor release** (e.g. `0.5.0`) with changelog entry: "Added `@dexterai/vault/tab` — composed open/stream/settle instruction builders promoted from the facilitator. Additive; prior consumers unchanged." *(DOC + publish.)*

Net: steps 2/4/7 are the heart — promote proven code, then delete the duplicates. Almost nothing here is greenfield; it is consolidation of code that already works on mainnet.

---

## 6. WHAT NOT TO DO — overreaches to avoid

1. **Do NOT hide / collapse / internalize the primitives.** The what-it-does lens rec to "collapse the 3 set_swig variants and make ~44 parts internal" is a **breaking change to live consumers** and actively wrong. dexter-api imports `buildSetSwigAtomicFromIdentity` directly (`firstUseBundle.ts:34`); dexter-x402-sdk re-exports SDK constants + precompile by name (`dexter-x402-sdk/src/tab/index.ts:64-90`). The `DISCRIMINATORS` / domain tags ARE the byte-parity product per the README. Keep every part public; **ADD verbs alongside, subtract nothing.**

2. **Do NOT ship build+sign+send+confirm verbs.** Baking in an RPC connection, fee payer, signing strategy, and confirmation polling makes the verb **unusable by the actual consumers** — the facilitator and dexter-api own and customize all of those (facilitator injects its own fee payer, compute budget, Helius sender). The correct altitude is `instantPayout.ts`: composed, ordered `TransactionInstruction[]` with an injectable assembler. Orchestrate composition; do not own the transaction lifecycle.

3. **Do NOT build a client-side meter that REFUSES overspend.** A `SessionMeter` that refuses "before it hits the chain" invites a stale-cache TOCTOU bug where the SDK's local count disagrees with chain truth. The facilitator already refuses authoritatively against freshly-read on-chain state (`tabSettle.ts:286-293`), and the on-chain `RevolvingCapacityExceeded` is the real guard and must stay authoritative. A read helper that **reports** remaining capacity (`readTabMeter`, §3.2) is fine; one that **refuses** is a footgun.

4. **Do NOT rename the package or split out `@dexterai/tab`.** Highest blast radius available, buys nothing (§3.5). The subpath is the answer.

5. **Do NOT frame this as parts-box OR product.** It is both. Keep the byte-precise primitive layer (the current consumers depend on it; it is the parity guarantee) AND add the thin composed layer. Presenting it as an either/or positioning choice is a false dichotomy that would mislead the work.

6. **Do NOT trust the existing parity test as proof of correctness while reshaping.** It is a tautology (S0). Fix it *first* (step 1) so that the program tier the README and code disagree on can't drift further under you.

---

## Appendix — verification log (all checked against source 2026-06-07)

| Claim | Verified at |
|---|---|
| 4 consumers import subpath parts | grep across dexter-api / facilitator / x402-sdk / fe |
| facilitator IS the orchestration layer | `dexter-facilitator/src/tabSettle.ts:73-75, 250, 286-293, 323-408` |
| cumulative-delta math `cumulative - spent` | `tabSettle.ts:367` |
| `instantPayout.ts` = the precedent shape | full file read; injectable `assembleSignV2` at `:58/:84`, returns ix[] at `:93` |
| 20 discriminators (not 22, not 12) | `src/constants/index.ts:46-68` |
| 188-byte V2 session (README says 180) | `src/messages/session.ts:46,58`; README:28,146,168 |
| WebAuthnAssertion shipped (README says unshipped) | CHANGELOG 0.2.0; README:232 |
| byte-parity test is a tautology | `tests/byte-parity.test.ts:26-96` |
| api imports `buildSetSwigAtomicFromIdentity` directly | `dexter-api/src/vault/firstUseBundle.ts:34,170` |
| x402-sdk re-exports SDK constants/precompile | `dexter-x402-sdk/src/tab/index.ts:64-90` |
| no tab/loop subpath exists yet | `find src` + grep openTab/streamVoucher/closeTab → none |
| `hmacKey: serverSecret.subarray(0,32)` footgun | README:58,121 |
