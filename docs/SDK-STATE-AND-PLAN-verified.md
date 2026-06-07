# @dexterai/vault — What It Actually Is, and What We Do About It

**Date:** 2026-06-07
**Author:** credex/vault implementation agent (Branch's execution agent)
**Status:** My own verified assessment. This supersedes the machine audit (`SDK-DEEP-AUDIT-2026-06.md`) as the authority. The audit was input; everything below I personally checked against source, including where I DISAGREE with it. Where I say "verified," I read the bytes/lines myself.

---

## 0. How to read this

This is the plain-language answer to "I don't know what my own SDK does," followed by what to do. No finding here is taken on the audit's word — each was re-checked. My divergences from the audit are called out explicitly in §5.

---

## 1. What the SDK IS (plain)

`@dexterai/vault` is a **box of byte-perfect "punch-card printers."** The on-chain dexter-vault program is a picky machine that only accepts perfectly-formatted instructions. The SDK is ~44 small functions, each of which prints exactly one correctly-formatted instruction (`buildSettleVoucherInstruction`, `buildRegisterSessionKeyInstruction`, etc.), plus message encoders, signature helpers, and account readers.

It is a **parts box**, not a product. It hands you parts; it does not run a whole transaction for you. That is the correct design for its current users, and a problem for its future users — see §2.

**VERIFIED:** `src/index.ts` re-exports only types + a counterfactual helper; the real surface is low-level builders under subpaths (`./instructions`, `./messages`, `./precompile`, `./reader`, `./signers`, `./constants`, `./factoring`). No high-level `openTab`/`streamCharge`/`settleTab` exists anywhere (`grep` confirmed none).

## 2. Who uses it (and the server-vs-browser split that explains everything)

Four codebases import it:

- **dexter-api** — the main backend (enroll, provision, withdraw).
- **dexter-facilitator** — the server that settles tabs (moves the USDC at close).
- **dexter-x402-sdk** — the x402 library; re-exports some vault pieces by name.
- **dexter-fe** — the frontend.

The split that matters:

- **Servers (api, facilitator)** are POWER USERS. They hold their own keys, pay their own fees, talk to the chain directly, and *want raw parts* so they can assemble transactions their own way. The parts box serves them well.
- **A browser newcomer** (a stranger evaluating the SDK, a user clicking a button) is the OPPOSITE. They want "just do it for me," not a parts box.

The SDK is built for the servers. That's why it feels like "a list of functions" to anyone else — because it is, and that was the right call *for its current consumers*. The launch wants to court the browser newcomer, which the SDK does not currently serve. That tension is real and unresolved by the SDK as it stands.

## 3. The two real defects (both VERIFIED by me, not taken on the audit's word)

### Defect A — the product loop lives in the wrong place (verified)

**The "loop" = the actual product:** open a tab → stream micro-charges → settle/close → with a meter that the chain refuses to let overspend. That sequence is what a customer pays for.

You'd expect that sequence to live in the SDK. **It does not.** The SDK only has the per-step parts. The whole-sequence code was hand-written *inside a server* — `dexter-facilitator/src/tabSettle.ts`.

**VERIFIED with my own eyes** (`tabSettle.ts`):
- the meter math is hand-rolled: `const transferAmount = cumulativeAmount - active.spent;` (line ~367)
- overspend refusal is hand-rolled: it returns `non_monotonic_cumulative` and `cumulative_exceeds_session_cap` errors (lines ~284-295) against freshly-read on-chain state
- it hand-assembles the atomic settle (Ed25519 precompile + `settle_tab_voucher` + the Swig SignV2 transfer)

**Why this is the problem, in one line:** the SDK's own README brags it was built to END duplication — *"Three repos used to hand-roll these primitives and one missed a role; that bug is now structurally impossible."* That's true at the **byte (card) level**. It is **false at the loop-assembly level**, where the same atomic-settle sequence is now hand-written in at least three places: the facilitator, the program's test files, and partially `factoring/instantPayout.ts`. **The exact bug the SDK was created to kill grew back one level up.** Different repos again hand-roll the same thing; one can again drift.

### Defect B — the safety test guarantees nothing (verified, with one honesty correction)

Each instruction starts with an 8-byte "discriminator" tag. Wrong tag → chain rejects. The SDK's headline promise is that these are correct, guarded by `tests/byte-parity.test.ts`.

**VERIFIED** — that test does this:
```ts
expect(DISCRIMINATORS.settle_tab_voucher).toEqual(
  Uint8Array.from([173, 22, 98, 31, 110, 129, 59, 161]),  // a hand-copied duplicate of the constant
);
```
It checks the constant against a **hand-copied copy of itself**. That is always true. It does NOT independently derive the correct value. A typo'd discriminator, copy-pasted into the test as the "expected" value, passes green. The safety net is a smoke detector wired to a green light.

**MY HONESTY CORRECTION to the audit (this matters):** the audit's framing implies imminent danger. It is not currently violated. I derived `sha256("global:settle_tab_voucher")[:8]` MYSELF and it equals the shipped value — so today's discriminators are actually correct. The defect is that the guarantee is **absent**, not that it is **breached**. The risk is forward-looking: nothing would CATCH a future typo, especially as new instructions are added. Still must fix — but it is a latent hole, not a live fire. Calling it a live fire would be dishonest.

### Defect C (minor, verified) — the README is ~two program tiers stale

README says "version 2 / 12 discriminators / 180-byte session message." Reality: the program is V5, the SDK ships 20 discriminators, the session message is 188 bytes, `WebAuthnAssertion` already shipped, and there is ZERO mention of the credit / lockedClaim / factoring tiers or the open→stream→settle product. Anyone reading npm cannot even enumerate the parts correctly, let alone find the product.

## 4. What to do about it — my plan (ordered, lowest-risk first)

Almost none of this is greenfield. It is consolidation of code that already works on mainnet.

1. **Make the fake test real.** Rewrite `tests/byte-parity.test.ts` to DERIVE each discriminator from `sha256("global:"+name)` and/or cross-check against the bundled IDL, instead of comparing to a copy. Isolated, tests-only, zero blast radius. Do this first so nothing can drift while we reshape. **(Tests only.)**

2. **Promote the facilitator loop into the SDK as a `./tab` subpath.** Move the proven `tabSettle.ts` logic — the 3-instruction atomic settle, the `cumulative - priorSpent` meter math, the precompile/ordering knowledge — INTO the SDK, refactored to the shape `factoring/instantPayout.ts` already proves: returns an injectable, correctly-ordered `TransactionInstruction[]`, does NOT send. Add `openTab` / `settleTab` / a read-only `readTabMeter` (reports remaining capacity; never refuses — the chain stays authoritative). **(Mostly moving proven code, not inventing.)**

3. **Add the credit twin** (`drawCredit` etc.) the same way, from the credit lifecycle we just proved on mainnet. Same `./tab` or a sibling `./credit`.

4. **Cut the facilitator over to the new SDK `./tab` and DELETE its private copy.** This is the payoff — the duplication is gone, drift killed at the loop level. Facilitator still owns its fee payer / compute budget / Helius send; the SDK just hands it instructions.

5. **Rewrite the stale README** around capabilities: V5, 20 discriminators, 188-byte session, the credit/lockedClaim/factoring tiers, and a front-and-center open→stream→settle / 5×-turnover story.

6. **Ship additive as 0.5.0. Rename NOTHING. Hide NOTHING.** Add the `./tab` subpath to the exports map; remove no existing export. (See §5 for why.)

## 5. Where I DIVERGE from the machine audit (my authority, not its)

1. **Severity of the fake test.** The audit implies live danger; I verified the discriminators are currently correct. It is a latent hole (no future typo would be caught), not an active bug. Fix it, but state it honestly.

2. **The "never ship send verbs" absolutism.** The audit says the SDK must only ever return instruction arrays, never build+sign+send, because the servers own their own transaction lifecycle. That is RIGHT for the SDK CORE and its four server consumers. But it slightly under-weights the launch's actual need: a **browser newcomer** wants an easy "do it for me" path, and the live demo needs one too. My position: instruction-arrays are the core (correct), AND we keep the door open for a thin, optional, clearly-separated convenience tier for the browser/demo case. Don't foreclose it; don't bake it into the core.

3. **Naming = package vs brand.** The audit's "do not rename, additive `./tab` subpath" is about the NPM PACKAGE, and on that it's right (four repos import `@dexterai/vault` by subpath/by name; a rename is the highest-blast-radius move available and buys nothing). But this does NOT settle the PRODUCT BRAND question. "Tab" can be the public product noun everywhere (site, announcement, docs) while the package stays `@dexterai/vault` with a `./tab` subpath. The audit answered the package question, not the positioning question — don't let it auto-decide the brand.

4. **Trust the structure, re-verify the numbers.** The audit's lenses miscounted raw facts (one said 22 discriminators; truth is 20). The STRUCTURAL findings are sound and I confirmed the load-bearing ones; any specific NUMBER I would re-verify before quoting it publicly.

## 6. The one-paragraph version for Branch

Your SDK is a box of byte-perfect instruction-printers that four of your own servers depend on and genuinely want. The actual product — open a tab, stream, settle, chain-enforced overspend limit — was never put IN the SDK; it got hand-written inside the facilitator server (and copied into tests and one other file), quietly recreating the very duplication bug the SDK was built to eliminate, one level up. The one test meant to guarantee the SDK's byte-correctness checks a value against a copy of itself, so it guarantees nothing (though the values happen to be correct today). The fix is consolidation, not invention: make the test real, move the proven loop from the facilitator into a new `./tab` part of the SDK, delete the facilitator's copy, refresh the two-versions-stale README, and ship it as an additive 0.5.0 — renaming nothing, hiding nothing. "Tab" stays the product brand; `@dexterai/vault` stays the package.
