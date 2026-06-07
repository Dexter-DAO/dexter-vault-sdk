# PICKUP — `./tab` product layer COMPLETE, ready to publish 0.5.0. 2026-06-07

Read this first after a compact. Single source of truth for resuming with zero loss.
Written by credex/vault Claude for Branch.

═══════════════════════════════════════════════════════════════════════════════════
## TL;DR — WHERE WE ARE
═══════════════════════════════════════════════════════════════════════════════════

The `@dexterai/vault` SDK was turned from a byte-precise PARTS-BOX into **parts-box + a first-class
PRODUCT LAYER** (`./tab`), additively, breaking no consumer. Executed via superpowers
subagent-driven-development: 8 tasks, each implement → spec-review → quality-review → fix, then a
holistic final review = **SHIP-READY**. **143 tests green, tsc clean, dual-format build emits `./kit`
+ `./tab`.** All committed on `main` in dexter-vault-sdk. **NOTHING PUBLISHED (Branch-gated).**

THREE things remain (Branch's words): **(1) publish 0.5.0** (the closest-to-done — needs the version
bump + publish), **(2) the facilitator cutover** (Step B — deliberately deferred), **(3) GTM agent
review** of the flagged positioning calls.

═══════════════════════════════════════════════════════════════════════════════════
## WHAT'S DONE — the `./tab` + `./kit` work (all on main, unpushed→ see note)
═══════════════════════════════════════════════════════════════════════════════════

Repo: `/home/branchmanager/websites/dexter-vault-sdk`. Commits `bae8e90 → d0501d7` (+ the holistic-pass
had no fixes). Check `git log --oneline` — the tab/kit series is the recent run.

- **`./kit`** (`src/kit/index.ts`) — single home for `kitInstructionsToWeb3` + `getRpc` (was copy-pasted
  in 8 files). `src/factoring/kitBridge.ts` is now a re-export shim; `./factoring` works through it.
  Exported as the `@dexterai/vault/kit` subpath.
- **`./tab`** (`src/tab/{types,assembleSignV2,settleTab,openTab,readTabMeter,credit,index}.ts`) — six
  composed verbs, importable from `@dexterai/vault/tab`:
  - `openTab` (arm the tab — settle_voucher increment leg), `settleTab` (atomic Ed25519 precompile +
    settle_tab_voucher + Swig SignV2; computes delta = cumulative − priorSpent via a FRESH chain-read
    done INSIDE the verb), `readTabMeter` (read-only `{spent, maxAmount, remaining}`; NEVER refuses —
    chain stays authoritative).
  - `drawCredit` (FINANCIER swig funds → seller), `repayCredit` + `seizeCollateral` (USER swig funds →
    financier). The mainnet-proven credit instructions, wrapped.
  - ALL return `TransactionInstruction[]` and NEVER send (SDK = recipe, consumer = kitchen: fees,
    sending, keys). Injectable `assembleSignV2?` defaults to real Swig (`defaultAssembleSignV2`).
- **README** rewritten product-first + TRUTHFUL (was stale: said v2/12-disc/180-byte; now V5, **21**
  discriminators, 188-byte V2 session, WebAuthnAssertion shipped, credit/lockedClaim/factoring/tab
  tiers). The product hero carries a `<!-- GTM-DRAFT ... -->` marker — wording is GTM's to finalize.
- **CHANGELOG** has a `0.5.0 — 2026-06-07` entry (TEXT only — package.json version is still 0.4.2; the
  actual bump+publish is the gated step).
- **Byte-parity test fixed** earlier this session (commit 11022b1): now DERIVES discriminators from
  `sha256("global:<name>")` instead of comparing constants to copies of themselves (was a tautology).

Design lineage (all committed): spec `docs/superpowers/specs/2026-06-07-tab-product-layer-design.md`,
plan `docs/superpowers/plans/2026-06-07-tab-product-layer.md`, the machine audit
`docs/SDK-DEEP-AUDIT-2026-06.md`, my verified authority doc `docs/SDK-STATE-AND-PLAN-verified.md`.

### Quality gates the review flow caught (evidence it was worth it)
dexterAuthority?? feePayer footgun → made REQUIRED. Dead `mint` (settleTab) + `swigAddress` (openTab)
params → removed. Hollow type-only test → made to load the module. Tests asserted whose-swig but not
where-money-goes → strengthened to assert destination+amount. My plan said "20 discriminators" → the
implementer verified it's 21 (`migrate_v4_to_v5`).

═══════════════════════════════════════════════════════════════════════════════════
## WHAT'S NOT DONE — the three remaining items (Branch confirmed these)
═══════════════════════════════════════════════════════════════════════════════════

### (1) PUBLISH 0.5.0 — the closest-to-done; THIS IS THE NEXT MOVE
Everything is built/green/committed. To publish:
- Bump `package.json` version 0.4.2 → 0.5.0 (currently UNTOUCHED — the CHANGELOG text references 0.5.0
  but the version field wasn't bumped, deliberately, pending Branch's go).
- `npm publish --access public` (or the repo's `npm run release:minor` which does `npm version minor &&
  npm publish` — CHECK package.json scripts; `release:minor` was present at 0.4.2). NOTE: the README's
  product hero is GTM-DRAFT — Branch may want GTM to bless the wording BEFORE publish, OR publish now and
  let GTM refine in a 0.5.1 (Branch leaning "0.5 should be touched and updated and done" → likely
  publish now). CONFIRM with Branch which order he wants: publish-then-GTM-polish, or GTM-then-publish.
- GATED: no publish without Branch's explicit go (standing rule all session).

### (2) FACILITATOR CUTOVER — Step B, deliberately deferred (do NEXT after publish)
The `./tab` layer was built but the facilitator's PRIVATE hand-rolled copy of the loop
(`dexter-facilitator/src/tabSettle.ts`) was intentionally NOT touched — cutting a production
money-mover over to brand-new code in the same breath as writing it is the risk we avoided. Step B:
replace tabSettle.ts's hand-assembly with calls to the new SDK `@dexterai/vault/tab` verbs (it keeps
owning fee payer / compute budget / Helius send — the SDK just returns instructions), then DELETE its
private copy. THIS is the payoff that kills the composition-level drift. Requires the published (or
linked) 0.5.0. Its own brainstorm→plan→execute, or a focused change since the SDK API is now fixed.
NOTE: dexter-facilitator remote is now `origin` (was misnamed `upstream` from the Coinbase x402 PR
workflow — renamed + pushed this session).

### (3) GTM AGENT REVIEW — the flagged positioning calls (§7 of the spec)
Three positioning decisions wearing engineering costumes, defaulted in the spec, awaiting GTM confirm:
- **Credit inside `./tab`** vs a sibling `./credit` — defaulted INSIDE (the import line `import {openTab,
  drawCredit}` teaches credit-is-part-of-a-tab). 
- **README product-first** framing/wording (the GTM-DRAFT hero).
- **The DAP-SDK two-sided story** — `./tab` is the BUYER half; the SELLER half already exists in
  `@dexterai/x402/tab/seller` (verified this session). Brand = "Dexter Agent Payments SDK / DAP SDK",
  Option C (one brand, TWO packages, NOT merged, NOT code-copied). See memory
  [[todo-dap-sdk-brand-and-x402-cleanup]].
The GTM agent (Branch's parallel session) should react to the SPEC + this `./tab` reality. There was a
paused agent-to-agent transmission protocol mid-session — Branch paused it to focus on the SDK; resume
when ready. Use the `agent-mail` skill (no copy-paste) if both sessions are live.

═══════════════════════════════════════════════════════════════════════════════════
## THE BROADER ARC (don't lose the map)
═══════════════════════════════════════════════════════════════════════════════════
Today, in order: finished Credit-L2 (deployed to mainnet + 10-scenario suite GREEN — see
[[credit-l2-deployed-2026-06-06]]); documented the passkey-as-direct-on-chain-signer primitive
(dexter-thesis/primitives/, emailed); cleaned + pushed all 3 repos; ran a multi-agent SDK audit; then
brainstorm→plan→executed the `./tab` layer (this doc).

PARKED items (in memory, not lost): the live-chain demo cap-stop bug
[[todo-live-chain-demo-cap-stop-bug]]; the Solana Security Standard "bow" pass before announce
[[todo-sdk-deeplook-and-security-standard]]; the x402-sdk cleanup
[[todo-dap-sdk-brand-and-x402-cleanup]]; the Ε Ζ-gates (buyer-protection + financier async passkey,
both in [[credit-l2-deployed-2026-06-06]]); the 90-day recovery-window question
[[open-q-90day-recovery-window]].

═══════════════════════════════════════════════════════════════════════════════════
## DISCIPLINE / HOW WE WORK (so it doesn't reset)
═══════════════════════════════════════════════════════════════════════════════════
- Answer with chest, no hedging/defensiveness, no "honest"-preface or "we are not X" slop, no
  context-budget complaints, no minimizing scope by reflex (Branch caught this repeatedly — don't
  pre-negotiate down what's achievable; find out by doing). Walk past→present→future.
- NO publish / NO version bump / NO push without Branch's explicit per-step go. "Main always" (consent
  to work on main). Build→restart-PM2 pattern for deployed services (not relevant to the SDK, but for
  facilitator after cutover: pm2 restart dexter-facilitator).
- Superpowers flow for big work (brainstorm→plan→subagent-driven exec w/ 2-stage review + holistic).
- Verify against SOURCE, never trust an illustrative shape (this session the implementers caught
  several of MY plan's inaccuracies by reading the real builders — keep that discipline).
- Tests: `cd /home/branchmanager/websites/dexter-vault-sdk && npx tsc --noEmit && npx vitest run`
  (143 green) and `npm run build` (emits dist/kit + dist/tab).

═══════════════════════════════════════════════════════════════════════════════════
## RESUME — exact next move
═══════════════════════════════════════════════════════════════════════════════════
Ask Branch the publish-order question (publish 0.5.0 now then GTM-polish, OR GTM-confirm then publish).
If publish now: bump package.json 0.4.2→0.5.0, confirm `npm run build` + `npx vitest run` green, then
on his go `npm publish --access public` (or `npm run release:minor`). Then (2) facilitator cutover, then
(3) GTM. Everything is committed; nothing is at risk.
