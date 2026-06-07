# Design Spec — The `./tab` Product Layer + SDK Cleanup

**Date:** 2026-06-07
**Author:** credex/vault implementation agent, with Branch (brainstormed + locked decision-by-decision)
**Status:** DESIGN — awaiting Branch's review, then the GTM agent's review of the flagged positioning calls (§7), then writing-plans.

**Sequencing of reviews:** The ENGINEERING decisions (organization, verb shapes, chain-read, assembler, helper home, cutover-in-two-steps, no-rename/no-hide/no-send guardrails) are locked and do NOT need GTM input — they can proceed to planning immediately. The §7 positioning calls (credit-inside-`./tab`, product-first README, the two-sided story) only affect (a) which subpath credit verbs export from and (b) README wording — both are LATE-binding and reversible, so the plan can be written and even most execution can begin before GTM confirms. GTM confirmation is required before the README is finalized (piece #3) and before we'd treat the credit-export location as permanent. Net: GTM is not a blocker for starting; it's a gate on the two cosmetic-but-positioning surfaces.

---

## Goal

Turn `@dexterai/vault` from a byte-precise parts-box into **a parts-box PLUS a first-class product layer**, by promoting the proven tab/credit settlement loop out of the facilitator and into the SDK as a `./tab` subpath — additively, breaking no existing consumer.

## The three pieces (executed in this order)

1. **Helper dedup** — the `kitInstructionsToWeb3` bridge helper is copy-pasted in 8 places. Give it one home (`./kit`) and import it everywhere. *Foundation — `./tab` builds on it.*
2. **The `./tab` product layer** — promote the facilitator's hand-rolled settle loop into the SDK as composed verbs. *The main work.*
3. **README rewrite** — make the front door truthful and product-first. *Last — describes the finished thing.*

Order rationale: foundation → building → sign on the door. Each step makes the next cleaner.

---

## Context: the system is THREE-sided (the reframe that shaped this design)

This is not "buyer + facilitator." There are three parties, and their code lives in three homes:

| Party | What they do | Code lives in |
|---|---|---|
| **Buyer / agent** | open tab, stream, settle, draw credit | `@dexterai/vault` (this SDK) — buyer-side |
| **Seller** | verify each voucher, meter, serve content | `@dexterai/x402/tab/seller` — **already built, different package** |
| **Facilitator** | move the USDC at settle time | `dexter-facilitator` (server) |

**Key fact (verified):** the seller side already has a clean high-level surface (`tabMiddleware`, `requireTab`, `openSse` in `@dexterai/x402/tab/seller`). A seller accepts agent payments in ~10 lines today. The verification logic (parse registration, verify ed25519 voucher signature, enforce cap/expiry/counterparty/monotonicity) is real seller work and it lives there — NOT in this SDK, correctly (sellers care about HTTP/x402; buyers care about the vault).

**Implication for this work:** the `./tab` layer we build is the **BUYER HALF of a two-sided product.** After it ships, both sides have a friendly high-level layer (seller already does; buyer will). That symmetry is a launch-story asset — flagged for GTM (§7).

---

## Why this work exists: the duplication the SDK was meant to kill, grown back one level up

The SDK's own README brags it ended drift: *"Three repos used to hand-roll these primitives and one missed a role; that bug is now structurally impossible."* True at the byte (single-instruction) level. **False at the composition level:** the "settle = [vault instruction] + [Swig SignV2 transfer], atomic" recipe is currently hand-written in 3 places — `dexter-facilitator/src/tabSettle.ts`, the SDK's own `factoring/instantPayout.ts`, and the program test files. They are not identical copies (they settle different things — tab vs locked-claim) but they re-implement the same *pattern*, and they can drift. Promoting the recipe into `./tab` and cutting the facilitator over to it makes one official copy.

(NOTE — honesty correction to the machine audit: the "3 copies of the loop" is pattern-repetition across 3 different operations, a real smell but not an identical-copy disaster. The clean-cut duplication is the `kitInstructionsToWeb3` helper — genuinely identical, copied 8×. That's piece #1.)

---

## ARCHITECTURE — organize by capability, not by audience

The SDK is organized by **what code does** (`./instructions`, `./messages`, `./reader`, `./precompile`, `./signers`, `./constants`, `./factoring`) — NOT by who calls it. There is no "buyer folder" or "facilitator folder," and there must not be. The tab loop is a *composed-operation capability* ("settle a tab"), the same category as `./factoring` ("instant-payout a claim"). So it lives as a **sibling subpath of `./factoring`.**

The dividing line for what moves vs. stays: **the SDK gets the RECIPE (compose these instructions); the facilitator keeps the KITCHEN (who pays fees, who sends, which key signs, compute budget, Helius).** This is exactly why the `./tab` verbs return `TransactionInstruction[]` and never send — sending is kitchen, composing is recipe.

### New exports map additions
```jsonc
"./kit":  { "types": "./dist/kit/index.d.ts",  "import": "./dist/kit/index.js",  "require": "./dist/kit/index.cjs" },
"./tab":  { "types": "./dist/tab/index.d.ts",  "import": "./dist/tab/index.js",  "require": "./dist/tab/index.cjs" }
```
Everything currently in `exports` stays byte-for-byte identical. Nothing removed, renamed, or hidden. (Live consumers import primitives by name — hiding any is a breaking change, forbidden.)

---

## PIECE 1 — Helper dedup (`./kit`)

**Problem:** `kitInstructionsToWeb3` (a Swig-kit-v2 → web3.js-v1 instruction translator) is copy-pasted in 8 files: `factoring/kitBridge.ts` + 7 program test files (`locked-claim-settle.ts`, `lock-voucher.ts`, `recover-abandoned-lock.ts`, `swig-settle-flow.ts`, `enroll-test-vault.ts`, `credit-antirug.ts`, `helpers/register-bootstrap.ts`).

**Fix:**
- Create `src/kit/index.ts` exporting `kitInstructionsToWeb3` and `getRpc` (the bridge utilities currently in `factoring/kitBridge.ts`).
- Re-point `factoring/` to import from `../kit/` (delete the `factoring/kitBridge.ts` copy, or have it re-export for back-compat — prefer delete + update imports since factoring is unpublished-new).
- Add `./kit` to the exports map so the program tests (a separate repo) can import it.
- Program-test cutover (the 7 test copies → import from `@dexterai/vault/kit`) happens in the dexter-vault repo as a follow-on; it's not blocking and lives in a different repo. Spec note only.

**Why `./kit` and not folding into `./factoring`:** it's a shared utility two composed layers (`./factoring`, `./tab`) both need, plus the tests. Putting it under `./factoring` would repeat the same "leaked into whoever needed it first" mistake at small scale. Organize by what it does → its own small home.

---

## PIECE 2 — The `./tab` product layer (the main work)

A new `src/tab/` subpath. All verbs: flat params object in, `Promise<TransactionInstruction[]>` out, injectable assembler defaulting to real Swig (the proven `instantPayout.ts` shape). They COMPOSE and RETURN instructions; they never send.

### The verb set (full scope — buyer side)

**Tab verbs:**
- `openTab(params)` — composes the `settle_voucher`(increment) leg that raises `current_outstanding` and arms the tab. Returns instructions.
- `settleTab(params)` — the 3-instruction atomic settle: Ed25519 precompile over the 44-byte voucher + `settle_tab_voucher` + Swig SignV2(TransferChecked) for the delta. **Reads the chain itself** to get prior-spent and computes `transferAmount = cumulativeAmount - priorSpent` internally (the freshness-read lives inside the verb so it can't be gotten wrong — mirrors the facilitator's proven `readVaultFull`-then-settle discipline). On-chain `settle_tab_voucher` re-validates monotonicity/cap, so a stale read fails safe on-chain.
- `readTabMeter(connection, vaultPda)` — READ-ONLY reporter: `{ spent, maxAmount, remaining }` (field names VERIFIED against `src/reader/accountReader.ts` — `activeSession` exposes `spent` + `maxAmount` as native bigints; `remaining = maxAmount - spent`, clamped ≥ 0). Reports remaining headroom under the session cap; NEVER refuses. The on-chain cap guard stays authoritative. (A client-side refuser would invite a stale-cache TOCTOU bug — explicitly out of scope, see §6.)

**Credit verbs (same shape, already-built+mainnet-proven instructions underneath):**
- `drawCredit(params)` — composes `draw_credit` + financier-swig SignV2 to seller. The financier's vault funds it (swig = `standby_backer`).
- `repayCredit(params)` — composes `repay_credit` + user-swig SignV2 to financier. Clamps to outstanding borrowed.
- `seizeCollateral(params)` — composes `seize_collateral` + user-swig SignV2 to financier, post-deadline.

Credit verbs live INSIDE `./tab` (not a sibling `./credit`) — DECISION: the import line is a positioning statement. `import { openTab, drawCredit } from '@dexterai/vault/tab'` teaches that credit is a *property of a tab* ("the tab that can spend past the balance"), which reinforces the product story. A separate `./credit` would imply credit is a bolt-on, contradicting the thesis. **(GTM-flagged — §7.)**

### Parameter shapes (concrete, mirroring `InstantPayoutParams`)

```ts
// settleTab — the central verb; sets the pattern
interface SettleTabParams {
  connection: Connection;          // for the internal freshness-read + assembler
  vaultPda: PublicKey;
  swigAddress: PublicKey;          // the USER's swig (tab funds come from buyer)
  channelId: Uint8Array;           // 32 bytes
  cumulativeAmount: bigint;        // running total; delta computed internally
  sequenceNumber: number;          // u32
  sessionSigner: SessionSigner;    // from ./signers — signs the 44-byte voucher
  mint: PublicKey;
  sellerAta: PublicKey;
  feePayer: PublicKey;
  assembleSignV2?: AssembleSignV2; // injectable; defaults to real swig-kit
}

// openTab
interface OpenTabParams {
  vaultPda: PublicKey;
  swigAddress: PublicKey;
  amount: bigint;                  // initial outstanding to arm
  dexterAuthority: PublicKey;
  // + session/channel identity as needed
}

// drawCredit (credit twin — financier funds)
interface DrawCreditParams {
  connection: Connection;
  userVaultPda: PublicKey;
  financierSwig: PublicKey;        // == vault.standby_backer; funds the draw
  amount: bigint;
  recoveryWindowSeconds: bigint;
  dexterAuthority: PublicKey;
  mint: PublicKey;
  sellerAta: PublicKey;
  feePayer: PublicKey;
  assembleSignV2?: AssembleSignV2;
}
// repayCredit / seizeCollateral: same mold, user swig, financier destination.
```
(Exact fields refined at implementation against the existing builders; these mirror the proven `InstantPayoutParams` precedent.)

### Source: promote, don't invent
`settleTab` is a port of `dexter-facilitator/src/tabSettle.ts` (the 3-ix atomic composition + the `cumulative - priorSpent` delta math), refactored to the `instantPayout.ts` shape (injectable assembler, returns instructions, drop the Anchor/Express binding). The credit verbs port from the proven credit lifecycle (the mainnet-green `credit-lifecycle.ts` / `credit-antirug.ts` flows + the `instantPayout` assembler pattern). Almost nothing is greenfield.

---

## PIECE 3 — README rewrite

Make it truthful and product-first.

**Truthfulness fixes (verified stale):** README says "version 2 / 12 discriminators / 180-byte session / BrowserPasskeySigner unshipped." Reality: V5 program, 20 discriminators, 188-byte V2 session, `WebAuthnAssertion` shipped in 0.2.0. Zero mention of credit / lockedClaim / factoring / the revolving meter. All corrected.

**Shape — product-first (GTM-flagged, §7):** lead with the product story (open a tab for your agent: non-custodial, chain-enforced limit, can extend credit; the 5-line `openTab`/`settleTab` example), then "under the hood — the byte-precise primitives" for power users. Rationale: the README is the front door for the launch traffic spike; optimize it for the newcomer who doesn't know what this is, keep the parts reference one scroll down for the 4 server consumers who already know them. Also: note the two-sided story (buyer here, seller in `@dexterai/x402/tab/seller`).

---

## TESTING

Mirror `factoring.instantPayout.test.ts`: unit-test each `./tab` verb with an INJECTED fake `assembleSignV2`, asserting instruction COMPOSITION and ORDERING without live Swig — fast, offline, deterministic. Assert: correct discriminator/account order per composed instruction, the delta math (`cumulative - priorSpent`) for `settleTab`, and the overspend-REPORTING (not refusing) behavior of `readTabMeter`. The chain-read in `settleTab` is made injectable for tests too (so no mainnet dependency in unit tests). The real mainnet end-to-end is already proven (the tab settle-flow + credit suites that exist); `./tab` unit tests verify the SDK composes the same bytes those proved.

The byte-parity test fix (deriving discriminators from `sha256("global:"+name)`) is ALREADY DONE (committed `11022b1`) and is the foundation guaranteeing the primitives `./tab` composes are correct.

---

## FACILITATOR CUTOVER — two steps, deliberately

1. **Step A (this work):** build + ship `./tab` in the SDK. Facilitator UNTOUCHED — keeps its own working `tabSettle.ts`. Prove the SDK layer (unit tests + a smoke against mainnet).
2. **Step B (follow-on, separate):** cut the facilitator over — replace its hand-rolled assembly with calls to the SDK verbs, delete its private copy. Facilitator keeps the kitchen (fee payer, compute budget, Helius send). This is the payoff (drift killed) but it touches a PRODUCTION MONEY-MOVER, so it does NOT happen in the same breath as introducing the new code. The duplication surviving one extra step is a smaller risk than a regression in the live settle path.

---

## WHAT NOT TO DO (explicit guardrails)

1. Do NOT rename the package or split out `@dexterai/tab`. Additive `./tab` subpath only. (4 repos import `@dexterai/vault` by subpath/by name; rename = highest blast radius, buys nothing. "Tab" is the BRAND, `@dexterai/vault` stays the PACKAGE.)
2. Do NOT hide/collapse/internalize any existing primitive. dexter-api imports `buildSetSwigAtomicFromIdentity` directly; dexter-x402-sdk re-exports SDK constants/precompile by name. Add verbs alongside; subtract nothing.
3. Do NOT ship build+sign+send+confirm verbs. Compose & return instructions; the consumers own the transaction lifecycle. (A send-verb is unusable by the facilitator + dexter-api.)
4. Do NOT build a client-side meter that REFUSES overspend. Report only (`readTabMeter`); the chain's `RevolvingCapacityExceeded` is authoritative.
5. Do NOT do the facilitator cutover in the same step as building `./tab`.

---

## §7 — DECISIONS FLAGGED FOR THE GTM AGENT

These are positioning calls wearing engineering costumes. Default chosen; GTM confirms or overrides at design review:
1. **Credit inside `./tab` vs sibling `./credit`** — defaulted to INSIDE (`import { openTab, drawCredit }` teaches credit-is-part-of-a-tab). Pure positioning.
2. **README product-first vs parts-first** — defaulted to PRODUCT-FIRST. It's the marketing surface; GTM owns the words, we own that it's accurate.
3. **The two-sided story** — `./tab` is the buyer half; the seller half already exists in `@dexterai/x402/tab/seller`. How to tell the two-package, two-sided product story (and whether the launch leads with buyer, seller, or both) is GTM's call. NEW INFO for the GTM agent: after this work, both sides have a clean high-level layer — a symmetry the announcement can use.

---

## Success criteria

- `./kit` exists; the bridge helper has ONE home; `./factoring` imports it (no `factoring/kitBridge.ts` copy).
- `./tab` exposes `openTab`/`settleTab`/`readTabMeter` + `drawCredit`/`repayCredit`/`seizeCollateral`, all composing+returning instructions, all unit-tested with injected assemblers.
- Nothing existing renamed/removed/hidden; all 4 consumers still build.
- README is truthful (V5/20/188/credit) and product-first.
- Shipped additive as 0.5.0. NO publish without Branch's go.
- Facilitator cutover is documented as Step B, NOT done in this work.
- The GTM-flagged calls (§7) are confirmed by the GTM agent before they're treated as final.
