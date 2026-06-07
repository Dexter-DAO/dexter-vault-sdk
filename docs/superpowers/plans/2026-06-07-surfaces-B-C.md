# Surfaces B + C Implementation Plan — "Open a Tab" page + "Connect a Tab" button

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the two launch surfaces for Tab — Surface B (a hosted `/tab` page in dexter-fe with a consumer "Open a Tab" flow + a builder SDK door) and Surface C step-1 (an embeddable "Connect a Tab" auth button + verifier + integration doc in the `@dexterai/vault` SDK under a new `./connect` subpath).

**Architecture:** Two repos, two natures. **Surface B** is a Next.js page (`dexter-fe/app/tab/page.tsx`) that REUSES the already-built, already-on-brand vault component set (`VaultAccountCard`, `DepositPanel`, `WithdrawPanel`, `VaultMark`, `AnimatedUsd`) — composed into a NEW "Centered Monument" hero with all user-facing copy relabeled vault→tab. **Surface C** is a new SDK subpath (`@dexterai/vault/connect`) wrapping the already-live `prove_passkey` engine: a relying-app verifier (C1), a browser button+ceremony (C2), and an integration doc (C3). C4 (the spend grant) is SPEC-ONLY this window. The on-chain engine is NOT touched — it's live on mainnet.

**Tech Stack:** Next.js 14 App Router + React + CSS Modules + shadcn tokens (dexter-fe, theme: light default / `.dark`, Dexter primary `#f26b1a`); TypeScript + tsup dual-format + vitest (dexter-vault-sdk); existing `provePasskey.ts` builder + `WebAuthnAssertion` browser signer; Solana web3.js for simulation-based verification.

---

## CRITICAL CONTEXT FOR EVERY IMPLEMENTER (read before any task)

### The locked vocabulary (do NOT drift — GTM-locked across B, C, announcement)
- **"Open a Tab"** = the CREATE moment, done ONCE on Dexter (Surface B's primary CTA).
- **"Connect a Tab"** = the USE moment, done repeatedly on other apps (Surface C's button label). Verb borrowed from "Connect Wallet", NOT "Sign in with X".
- **"Tab"** = the noun (the bounded spending account).
- **Shared one-liner (verbatim):** *"Open a tab once. Connect it anywhere. Your agent spends, up to the limit you set."*
- **The non-custody line (verbatim, locked):** *"Your money stays yours — you can see every dollar. You give your agent a tab with a hard limit, and it's the chain that enforces the limit, not us. We couldn't let it overspend even if we wanted to."*

### vault→tab is COPY ONLY
Relabel user-facing strings "vault"→"tab". NEVER rename the on-chain program, the component files, their internals, CSS class names, the `swigAddress`/`vaultPda` data fields, or any import. The word "vault" implies custody and poisons the non-custodial pitch — but only in *user-visible text*.

### Anti-slop is a HARD gate (both prose and visual)
- Prose gate: `bash ~/.claude/skills/dexter-anti-slop-prose/scripts/check.sh` (run on all page copy + the button copy + the integration doc).
- Visual move-count: 0–2 design moves clean, 3–4 defensible if each earns its place, 5+ cut half. NO left-stripe section cards (`border-l-2`), NO tracked-uppercase orange eyebrows on every section, NO gradient-text accent words, NO dashed dividers, NO three-column audience footer, NO emoji, NO rounded-corner-everything, NO over-containerization. The existing `VaultDashboard.module.css` already fought this fight (see its comments: "Full-border container (NOT a single-side stripe)") — match that discipline.

### The visual direction is LOCKED: "Centered Monument" (Branch's choice)
Single centered column. Large `VaultMark` emblem at top → headline (the one-liner) → a live tab card (balance via `AnimatedUsd` + a hard-limit bar showing spent/limit + "chain-enforced" mark) → `[ Open a Tab ]` CTA → `For builders →` toggle link. Calm, premium, scale-and-restraint bold. Mobile-primary (announcement traffic skews mobile) — verify iPhone-width.

### Verification rule (Branch's, non-negotiable)
UI is verified by RENDERING and reading the actual data, not by "it compiles." Use the laptop-browser skill to SEE both doors at desktop AND iPhone width. Confirm the confirmation screen shows REAL balance/limit/spent, not placeholders. The "view on-chain" link must resolve to the actual vault on Solscan.

### Repo hygiene (Branch's rules)
- `dexter-fe` is git `main`, PM2 process `dexter-fe` (online). After the B build: `npm run build` then `pm2 restart dexter-fe`, then verify `/tab` renders in the production build.
- `dexter-vault-sdk` is git `main`. Tests: `npx tsc --noEmit && npx vitest run`. Build: `npm run build`.
- NEVER `git add -A` / `git add .` — stage targeted paths only (parallel work leaves dirty trees). NEVER stash. Commit good code.
- NO publish / NO version bump / NO push without Branch's explicit go. The SDK `./connect` subpath is BUILT + COMMITTED this window but NOT published until Branch says so (a 0.6.0 later).

### Existing reuse map (VERIFIED present — do not assume the spec's partial lists)
`dexter-fe/app/components/wallet/vault/` contains 10 real files:
`VaultAccountCard.tsx`, `VaultMark.tsx`, `AnimatedUsd.tsx`, `DepositPanel.tsx`, `WithdrawPanel.tsx`, `ConfirmationBanner.tsx`, `RecoverStuckTab.tsx`, `ClaimWalletBanner.tsx`, `InitializedBanner.tsx`, plus `VaultDashboard.module.css` (the shared stylesheet) and `VaultMark.module.css`.
The current dashboard renders at `dexter-fe/app/wallet/page.tsx` — it wires `useVaultBalance` (`app/hooks/useVaultBalance.ts`) + vault status → `VaultAccountCard` + `DepositPanel` + `WithdrawPanel` inside a `vaultStyles.vaultSurface` section. Passkey setup lives at `app/wallet/setup-passkey/page.tsx` and is the no-vault redirect target. **Mirror this wiring for `/tab`.**

### Surface C engine (VERIFIED live — do NOT rebuild)
- On-chain `prove_passkey` — LIVE on mainnet (`Hg3wRayd…2fhc`).
- SDK builder `dexter-vault-sdk/src/instructions/provePasskey.ts` — EXISTS.
- Browser signer `dexter-vault-sdk/src/signers/browser/index.ts` (`WebAuthnAssertion`) — EXISTS.
- No `src/connect/` subpath yet — this plan creates it and adds `./connect` to `package.json` exports.

---

# PART 1 — SURFACE B (dexter-fe `/tab` page). Execute FIRST.

## Task B0: Surface session spent + limit from chain → dexter-api `/status` → fe type

**Why this exists (Branch's decision):** the `/tab` Centered Monument hero features a live hard-limit bar ("spent $X / $Y limit"). The fe today has NO spend/limit data — `VaultOnchainStatus` carries only `pendingVoucherCount` etc. The on-chain `SessionRegistration` holds `spent` + `max_amount`, and the SDK reader ALREADY decodes them via `readVaultFull()` — but dexter-api's `resolveVaultState.ts` currently calls the SLIM `readVaultOnchain()` which drops them. This task switches to the full read and passes the two fields through to the fe. Small: no new byte-parsing, the SDK does the decode.

**Files:**
- Modify: `dexter-api/src/vault/resolveVaultState.ts` (the `readOnchainBlock` fn + the `import { readVaultOnchain }` line + the returned object's local type)
- Modify: `dexter-fe/app/lib/vault/client.ts` (`VaultOnchainStatus` interface — add `sessionSpent`/`sessionLimit`)
- Reference (read first): `dexter-vault-sdk/src/reader/accountReader.ts` (confirm `readVaultFull` returns `activeSession.{ spent, maxAmount }` — VERIFIED present at lines 130-138: `maxAmount` at bodyStart+32, `spent` at bodyStart+84, both `bigint`)

**VERIFIED FACTS (resolved at plan time, do NOT re-litigate):**
- `readVaultFull` IS exported from `@dexterai/vault/reader` (the barrel re-exports `accountReader.js`). The exact name is `readVaultFull` (alongside `readVaultOnchain`).
- dexter-api has `@dexterai/vault@0.4.2` INSTALLED (a real node_modules dir, NOT a workspace symlink). That installed dist ALREADY ships `readVaultFull` — so NO SDK change, NO SDK republish, NO dep bump is needed. Just import and call it.
- **DO NOT edit the SDK's `VaultStateOnchainExtended` type.** dexter-api consumes a PUBLISHED package; editing SDK src wouldn't reach it without a republish (gated, out of scope). Instead, dexter-api extends ITS OWN return shape, and dexter-fe's `VaultOnchainStatus` is a hand-maintained mirror in `client.ts` (independent of the SDK type). So B0 touches ONLY dexter-api + dexter-fe.

- [ ] **Step 1: Confirm the reader's full-read shape**

Read `dexter-vault-sdk/src/reader/accountReader.ts`. Confirm `readVaultFull(connection, vaultPda)` returns an object with `activeSession: { spent: bigint, maxAmount: bigint, expiresAt, allowedCounterparty, ... } | null`. (Verified at plan-time: yes.) Note `spent`/`maxAmount` are `bigint` — they must be stringified for JSON transport (the existing code stringifies `usdcAtomic` the same way).

- [ ] **Step 2: Switch `resolveVaultState.ts` to the full read and surface the two fields**

In `dexter-api/src/vault/resolveVaultState.ts`:
- Change the import on line 8 from `import { readVaultOnchain } from '@dexterai/vault/reader';` to also pull the full reader: `import { readVaultOnchain, readVaultFull } from '@dexterai/vault/reader';` (verify the exact exported name in the SDK reader's barrel — it may be `readVaultFull` or similar; use the real export).
- In `readOnchainBlock` (lines 70-105), replace the `readVaultOnchain(...)` call inside the `Promise.all` with `readVaultFull(...)` so `oc.activeSession` is available.
- Add to the returned object (after `usdcAtomic`):
```ts
      // Live session spend meter — null when no active session. Stringified
      // (bigint → string) for JSON transport, same as usdcAtomic.
      sessionSpent: oc.activeSession ? oc.activeSession.spent.toString() : null,
      sessionLimit: oc.activeSession ? oc.activeSession.maxAmount.toString() : null,
```
> IMPLEMENTER NOTE: if `readVaultFull` is materially heavier than the slim read (it parses the whole account), that's fine here — `/status` already does a USDC ATA round-trip in parallel; one full account decode is negligible. Keep the existing degrade-to-null-on-failure try/catch wrapping.

- [ ] **Step 3: Type the two new fields on dexter-api's OWN return shape (no SDK edit)**

dexter-api imports the onchain type as `VaultStateOnchainExtended as VaultStateOnchain` from `@dexterai/vault/types` (line 13). Since we must NOT edit the published SDK type, declare the two new fields on dexter-api's side. The cleanest move: change the `readOnchainBlock` return annotation from `Promise<VaultStateOnchain | null>` to a LOCAL extended type defined in `resolveVaultState.ts`:
```ts
// Local extension: the published @dexterai/vault type doesn't yet carry the
// session spend meter. We surface it from readVaultFull's activeSession.
// (When the SDK type is next published with these fields, this local type can
// be dropped in favor of the imported one.)
type VaultStateOnchainWithMeter = VaultStateOnchain & {
  sessionSpent: string | null;
  sessionLimit: string | null;
};
```
Use `VaultStateOnchainWithMeter` as the `readOnchainBlock` return type. If TS complains that the returned object doesn't satisfy the base `VaultStateOnchain` (e.g. `usdcAtomic` isn't on the base type either), follow whatever pattern the EXISTING code uses for `usdcAtomic` — it's already returned (line 99) despite possibly not being on the base type, so mirror exactly how that field is typed/cast today.

- [ ] **Step 4: Add the fields to the fe `VaultOnchainStatus`**

In `dexter-fe/app/lib/vault/client.ts`, add to `VaultOnchainStatus` (after `usdcAtaExists?`):
```ts
  /** Live cumulative spent against the active tab session, atomic USDC string. Null = no active session. */
  sessionSpent?: string | null;
  /** The active tab session's limit (max_amount), atomic USDC string. Null = no active session. */
  sessionLimit?: string | null;
```

- [ ] **Step 5: Test the live /status response carries the fields**

Restart dexter-api and hit the real status endpoint for a known vault WITH an active session:
```bash
cd /home/branchmanager/websites/dexter-api && npm run build && pm2 restart dexter-api
# then, for a known enrolled vault (use a real test identity):
curl -s "https://api.dexter.cash/api/passkey-vault/status?<the real query params used by the fe>" | jq '.onchain | {sessionSpent, sessionLimit, pendingVoucherCount}'
```
Expected: for a vault with an active session, `sessionSpent` and `sessionLimit` are numeric strings (atomic USDC). For a vault with NO active session, both `null`. READ the actual JSON and confirm the numbers are sane (limit ≥ spent, both ≥ 0) — not just a 200.

> IMPLEMENTER NOTE: the exact `/status` path + query params are whatever the fe `fetchVaultStatus` calls (`app/lib/vault/client.ts` says the backend is `/api/passkey-vault/*` at `NEXT_PUBLIC_API_ORIGIN`). Read `fetchVaultStatus` for the precise route + params before curling.

- [ ] **Step 6: Confirm prod RPC is Helius (not mainnet-beta)**

`resolveVaultState.ts:20-23` falls back to `api.mainnet-beta.solana.com` if `HELIUS_RPC_URL`/`SOLANA_RPC_ENDPOINT` are unset. Confirm the dexter-api PM2 env has `HELIUS_RPC_URL` set in production (`pm2 env dexter-api | grep -i 'HELIUS\|SOLANA_RPC'` or check the ecosystem config). This is an EXISTING line, not introduced here, but we're in the file — verify, don't silently rely on the fallback. If unset, flag to Branch (do NOT hardcode a key).

- [ ] **Step 7: Commit (TARGETED paths only — both repos have dirty trees from parallel work)**

⚠️ dexter-api's working tree is DIRTY (parallel work: `prisma/schema.prisma`, `src/app.ts`, x402gle files, untracked docs). dexter-fe may be too. NEVER `git add -A` / `git add .`. Stage ONLY the two files this task touched:

```bash
cd /home/branchmanager/websites/dexter-api
git add src/vault/resolveVaultState.ts
git commit -m "feat(vault): surface active-session spent + limit on /status (readVaultFull) for the Tab spend meter"

cd /home/branchmanager/websites/dexter-fe
git add app/lib/vault/client.ts
git commit -m "feat(tab): add sessionSpent/sessionLimit to VaultOnchainStatus (mirrors /status)"
```
NO SDK repo commit — B0 does not touch the SDK.

---

## Task B1: Scaffold the `/tab` route + audience toggle + Centered Monument hero shell

**Files:**
- Create: `dexter-fe/app/tab/page.tsx`
- Create: `dexter-fe/app/tab/tab.module.css`
- Reference (read, do not modify): `dexter-fe/app/wallet/page.tsx`, `dexter-fe/app/components/wallet/vault/VaultMark.tsx`, `dexter-fe/app/components/wallet/vault/VaultDashboard.module.css`

- [ ] **Step 1: Create the route shell with the audience toggle and the locked hero copy**

Create `dexter-fe/app/tab/page.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { VaultMark } from '../components/wallet/vault/VaultMark';
import styles from './tab.module.css';

type Door = 'people' | 'builders';

export default function TabPage() {
  const [door, setDoor] = useState<Door>('people');

  return (
    <main className={styles.page}>
      <div className={styles.monument}>
        <VaultMark state="sealed" size={96} />
        <h1 className={styles.headline}>
          Open a tab once.<br />Connect it anywhere.
        </h1>
        <p className={styles.subhead}>
          Your agent spends, up to the limit you set.
        </p>

        {door === 'people' ? (
          <section className={styles.door} aria-label="Open a Tab">
            {/* B2 fills this: the consumer Open-a-Tab flow */}
            <button type="button" className={styles.cta}>Open a Tab</button>
            <button
              type="button"
              className={styles.doorLink}
              onClick={() => setDoor('builders')}
            >
              For builders →
            </button>
          </section>
        ) : (
          <section className={styles.door} aria-label="For builders">
            {/* B3 fills this: the SDK door */}
            <button
              type="button"
              className={styles.doorLink}
              onClick={() => setDoor('people')}
            >
              ← Open a Tab
            </button>
          </section>
        )}
      </div>
    </main>
  );
}
```

- [ ] **Step 2: Create the Centered Monument stylesheet using site tokens (no invented colors)**

Create `dexter-fe/app/tab/tab.module.css`. Use the same token strategy as `VaultDashboard.module.css` — read `--foreground`, `--muted-foreground`, `--card`, `--border`, `--radius`, and `--color-dexter-primary` (fallback `#f26b1a`). Centered single column, max-width ~560px, generous vertical rhythm. NO left-stripe cards, NO gradient text, NO uppercase eyebrows.

```css
.page {
  display: flex;
  justify-content: center;
  padding: clamp(2rem, 8vw, 6rem) 1.25rem;
  color: var(--foreground);
}
.monument {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 1.4rem;
  max-width: 560px;
  width: 100%;
}
.headline {
  font-size: clamp(2rem, 6vw, 3rem);
  line-height: 1.05;
  font-weight: 680;
  letter-spacing: -0.02em;
  margin: 0.4rem 0 0;
}
.subhead {
  font-size: clamp(1rem, 2.5vw, 1.15rem);
  color: var(--muted-foreground);
  margin: 0;
}
.door {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1rem;
  width: 100%;
  margin-top: 0.6rem;
}
.cta {
  font-size: 1.05rem;
  font-weight: 640;
  padding: 0.85rem 2.4rem;
  border: none;
  border-radius: var(--radius, 0.5rem);
  background: var(--color-dexter-primary, #f26b1a);
  color: #fff;
  cursor: pointer;
}
.cta:hover { filter: brightness(1.05); }
.doorLink {
  font-size: 0.92rem;
  color: var(--muted-foreground);
  background: none;
  border: none;
  cursor: pointer;
  padding: 0.25rem;
}
.doorLink:hover { color: var(--foreground); }
```

- [ ] **Step 3: Verify the route renders and the toggle flips**

Run: `cd /home/branchmanager/websites/dexter-fe && npm run dev` (or use the running dev server), then with the laptop-browser skill open `http://localhost:<port>/tab`.
Expected: centered VaultMark + "Open a tab once. Connect it anywhere." headline + subhead + "Open a Tab" button + "For builders →" link. Clicking "For builders →" swaps to the builder door with "← Open a Tab" back-link. Screenshot both states.

- [ ] **Step 4: Commit**

```bash
cd /home/branchmanager/websites/dexter-fe
git add app/tab/page.tsx app/tab/tab.module.css
git commit -m "feat(tab): scaffold /tab Centered Monument hero + audience toggle"
```

---

## Task B2: Door 1 — the consumer "Open a Tab" flow (reuse the real vault components)

**Files:**
- Modify: `dexter-fe/app/tab/page.tsx`
- Modify: `dexter-fe/app/tab/tab.module.css`
- Reference (read first): `dexter-fe/app/wallet/page.tsx` (the wiring to mirror), `dexter-fe/app/hooks/useVaultBalance.ts`, `dexter-fe/app/components/wallet/vault/VaultAccountCard.tsx`, `dexter-fe/app/components/wallet/vault/DepositPanel.tsx`, `dexter-fe/app/lib/vault/client.ts`

- [ ] **Step 1: Read `app/wallet/page.tsx` end-to-end to learn the exact hook + status wiring**

Before writing: read how `wallet/page.tsx` gets vault status, calls `useVaultBalance(...)`, handles the no-vault redirect to `/wallet/setup-passkey`, and passes `status`/`balance`/`reconcile` into `VaultAccountCard`. The `/tab` Door 1 mirrors this. Note the real fields on `VaultStatus` (from `app/lib/vault/client.ts`): `vault.receiveAddress`, `vault.swigAddress`, `vault.vaultPda`, `vault.coolingOffSeconds`, `onchain.pendingVoucherCount`.

- [ ] **Step 2: Wire Door 1 to render the live tab card with REAL data + tab-relabeled copy**

Replace the Door 1 placeholder in `page.tsx`. The flow has two visible states driven by whether a vault exists for the visitor: **(a) no tab yet** → a single "Open a Tab" CTA that routes to `/wallet/setup-passkey` (the existing passkey→fund flow); **(b) tab exists** → render `VaultAccountCard` (which already shows balance, deposit address, open-tabs chips, Solscan link) PLUS a hard-limit bar, with all user-facing strings relabeled vault→tab.

```tsx
// at top of page.tsx, add imports:
import { useRouter } from 'next/navigation';
import { useVaultBalance } from '../hooks/useVaultBalance';
import { VaultAccountCard } from '../components/wallet/vault/VaultAccountCard';
import { fetchVaultStatus, type VaultStatus } from '../lib/vault/client';
import { useEffect } from 'react';

// inside TabPage(), add state mirroring wallet/page.tsx's status load:
const router = useRouter();
const [status, setStatus] = useState<VaultStatus | null>(null);
const [statusLoading, setStatusLoading] = useState(true);

useEffect(() => {
  // mirror wallet/page.tsx's identity resolution; if it has a helper to read
  // the local vault identity, reuse it verbatim rather than re-deriving.
  let alive = true;
  (async () => {
    try {
      const id = readLocalVaultIdentity(); // reuse the SAME helper wallet/page.tsx uses
      if (!id) { if (alive) { setStatus(null); setStatusLoading(false); } return; }
      const s = await fetchVaultStatus(id);
      if (alive) { setStatus(s); setStatusLoading(false); }
    } catch { if (alive) { setStatus(null); setStatusLoading(false); } }
  })();
  return () => { alive = false; };
}, []);

// VERIFIED arg shape (from wallet/page.tsx:57-60): the FIRST arg is the
// receive/swig address (where USDC lives), NOT vaultPda. Passing vaultPda
// reads $0.
const expectingDeposit = status?.vault?.isActivated === false;
const balance = useVaultBalance(
  status?.vault?.receiveAddress ?? status?.vault?.swigAddress ?? null,
  { expectingDeposit },
);
```

> IMPLEMENTER NOTE: `readLocalVaultIdentity` is a placeholder for whatever helper `wallet/page.tsx` actually uses to resolve the visitor's vault identity (localStorage / supabase). Read that file and reuse the EXACT same mechanism — do not invent a new identity path. If `wallet/page.tsx` redirects to `/wallet/setup-passkey` when there's no vault, Door 1's "no tab yet" state should do the same on CTA click.
> ARG SHAPE IS VERIFIED, NOT A GUESS: `useVaultBalance(receiveAddress ?? swigAddress, { expectingDeposit })` — confirmed against `wallet/page.tsx:57-60` and the hook signature `useVaultBalance(swigAddress, { expectingDeposit })`. Do NOT pass `vaultPda`.

Door 1 JSX (tab-relabeled):

```tsx
<section className={styles.door} aria-label="Open a Tab">
  {statusLoading ? (
    <p className={styles.subhead}>Loading…</p>
  ) : status?.vault ? (
    <>
      <div className={styles.tabCard}>
        <VaultAccountCard
          status={status}
          balance={balance.balance}
          balanceLoading={balance.loading}
          reconcile={balance.reconcile}
        />
        <TabLimitBar
          spent={status.onchain?.sessionSpent ? Number(status.onchain.sessionSpent) / 1e6 : 0}
          limit={status.onchain?.sessionLimit ? Number(status.onchain.sessionLimit) / 1e6 : 0}
        />
        <p className={styles.enforceLine}>
          Your money stays yours — you can see every dollar. You give your agent a
          tab with a hard limit, and it&apos;s the chain that enforces the limit,
          not us. We couldn&apos;t let it overspend even if we wanted to.
        </p>
      </div>
      <button type="button" className={styles.doorLink} onClick={() => setDoor('builders')}>
        For builders →
      </button>
    </>
  ) : (
    <>
      <button
        type="button"
        className={styles.cta}
        onClick={() => router.push('/wallet/setup-passkey')}
      >
        Open a Tab
      </button>
      <button type="button" className={styles.doorLink} onClick={() => setDoor('builders')}>
        For builders →
      </button>
    </>
  )}
</section>
```

> IMPLEMENTER NOTE on the limit fields: B0 (run BEFORE this task) adds `sessionSpent`/`sessionLimit` to `status.onchain` as atomic-USDC STRINGS (or null when no active session). Divide by 1e6 for human USDC. `TabLimitBar` already returns null when `limit` is 0/falsy — so a vault with no active session renders the card WITHOUT a bar, no fabrication. The card (balance/addresses/open-tabs chip) renders regardless. Do NOT add a fallback that invents numbers; the bar's presence IS the signal that a live tab session exists.

- [ ] **Step 3: Add the `TabLimitBar` inline component + its styles**

Add to `page.tsx` (or a sibling file `app/tab/TabLimitBar.tsx` if cleaner):

```tsx
function TabLimitBar({ spent, limit }: { spent: number; limit: number }) {
  if (!limit) return null;
  const pct = Math.min(100, Math.round((spent / limit) * 100));
  return (
    <div className={styles.limitWrap}>
      <div className={styles.limitTrack}>
        <div className={styles.limitFill} style={{ width: `${pct}%` }} />
      </div>
      <span className={styles.limitLabel}>
        spent ${spent.toLocaleString()} / ${limit.toLocaleString()} limit
      </span>
    </div>
  );
}
```

Add to `tab.module.css`:

```css
.tabCard { width: 100%; display: flex; flex-direction: column; gap: 1.1rem; }
.limitWrap { display: flex; flex-direction: column; gap: 0.4rem; }
.limitTrack {
  height: 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--foreground) 10%, transparent);
  overflow: hidden;
}
.limitFill {
  height: 100%;
  background: var(--color-dexter-primary, #f26b1a);
}
.limitLabel { font-size: 0.82rem; color: var(--muted-foreground); }
.enforceLine {
  font-size: 0.9rem;
  line-height: 1.5;
  color: var(--muted-foreground);
  margin: 0;
  text-align: left;
}
```

- [ ] **Step 4: Verify Door 1 in a real browser with real data**

With the laptop-browser skill, open `/tab` as a visitor WITH a tab (use a known test vault identity in localStorage if needed, mirroring how `wallet/page.tsx` is tested).
Expected: VaultMark + headline + the live tab card showing the REAL balance number (not a placeholder), the deposit address with a working Solscan link, the open-tabs chip if any, the limit bar if session data exists, and the locked enforcement line. As a visitor WITHOUT a tab: the "Open a Tab" CTA routes to `/wallet/setup-passkey`. Screenshot both.

- [ ] **Step 5: Commit**

```bash
cd /home/branchmanager/websites/dexter-fe
git add app/tab/page.tsx app/tab/tab.module.css
git commit -m "feat(tab): Door 1 consumer Open-a-Tab flow — reuse VaultAccountCard, tab-relabeled, limit bar + enforcement line"
```

---

## Task B3: Door 2 — the builder "get the SDK" flow

**Files:**
- Modify: `dexter-fe/app/tab/page.tsx`
- Modify: `dexter-fe/app/tab/tab.module.css`
- Reference (read for the exact snippet): `dexter-vault-sdk/README.md` (the `openTab()` usage block — copy byte-for-byte; it's already anti-slop-clean)

- [ ] **Step 1: Read the published README's openTab snippet to copy verbatim**

Read `dexter-vault-sdk/README.md`, find the `openTab()` usage example and the install line. The Door 2 snippet must match the published `@dexterai/vault@0.5.0` surface exactly — do not paraphrase or invent an API shape.

- [ ] **Step 2: Fill Door 2 with the install + snippet + copy button + docs link**

Replace the builder-door placeholder in `page.tsx`:

```tsx
<section className={styles.door} aria-label="For builders">
  <div className={styles.builderCard}>
    <p className={styles.builderLede}>
      Two lines to give an agent a tab. The SDK composes the instructions; you
      keep fee-paying and sending.
    </p>
    <CodeBlock label="install" code={`npm i @dexterai/vault`} />
    <CodeBlock
      label="open a tab"
      code={/* PASTE the exact openTab() snippet from the published README here */ OPEN_TAB_SNIPPET}
    />
    <a
      className={styles.doorLink}
      href="https://github.com/Dexter-DAO/dexter-vault-sdk#readme"
      target="_blank"
      rel="noreferrer"
    >
      Full docs →
    </a>
  </div>
  <button type="button" className={styles.doorLink} onClick={() => setDoor('people')}>
    ← Open a Tab
  </button>
</section>
```

> IMPLEMENTER NOTE: replace `OPEN_TAB_SNIPPET` with the literal string copied from the README in Step 1. Verify the GitHub repo URL resolves (it may be `Dexter-DAO/dexter-vault-sdk` or another org slug — check `package.json` `repository` field in dexter-vault-sdk and use that exact URL).

- [ ] **Step 3: Add the `CodeBlock` component with a working copy button**

```tsx
function CodeBlock({ label, code }: { label: string; code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={styles.codeBlock}>
      <div className={styles.codeHead}>
        <span className={styles.codeLabel}>{label}</span>
        <button
          type="button"
          className={styles.copyBtn}
          onClick={() => {
            navigator.clipboard?.writeText(code).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1400);
            }).catch(() => {});
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className={styles.codePre}><code>{code}</code></pre>
    </div>
  );
}
```

Add to `tab.module.css`:

```css
.builderCard { width: 100%; display: flex; flex-direction: column; gap: 1rem; text-align: left; }
.builderLede { font-size: 0.95rem; color: var(--muted-foreground); margin: 0; }
.codeBlock { border: 1px solid var(--border); border-radius: var(--radius, 0.5rem); overflow: hidden; }
.codeHead {
  display: flex; justify-content: space-between; align-items: center;
  padding: 0.5rem 0.8rem;
  background: color-mix(in srgb, var(--foreground) 4%, transparent);
  border-bottom: 1px solid var(--border);
}
.codeLabel { font-size: 0.72rem; color: var(--muted-foreground); }
.copyBtn { font-size: 0.78rem; background: none; border: none; color: var(--color-dexter-primary, #f26b1a); cursor: pointer; }
.codePre { margin: 0; padding: 0.9rem 0.8rem; overflow-x: auto; font-size: 0.82rem; line-height: 1.5; }
```

- [ ] **Step 4: Verify Door 2 in a real browser**

With the laptop-browser skill, toggle to the builder door.
Expected: the install line + the exact `openTab()` snippet from the published README, both with working Copy buttons (click → "Copied" → reverts), and a "Full docs →" link that resolves to the real GitHub README. Screenshot.

- [ ] **Step 5: Commit**

```bash
cd /home/branchmanager/websites/dexter-fe
git add app/tab/page.tsx app/tab/tab.module.css
git commit -m "feat(tab): Door 2 builder flow — install + openTab() snippet (verbatim from published README) + copy buttons"
```

---

## Task B4: Anti-slop gate, Playwright happy-path, PM2 restart, live production verification

**Files:**
- Create: `dexter-fe/e2e/tab.spec.ts` (or wherever dexter-fe's Playwright specs live — inventory first)
- Reference: `~/.claude/skills/dexter-anti-slop-prose/scripts/check.sh`

- [ ] **Step 1: Run the prose anti-slop gate on all `/tab` copy**

Extract every user-facing string from `app/tab/page.tsx` into a scratch file and run:
`bash ~/.claude/skills/dexter-anti-slop-prose/scripts/check.sh < /tmp/tab-copy.txt`
Expected: 0 hits. Fix any flagged phrasing (keep the LOCKED verbatim lines — the one-liner and the enforcement line — unchanged; they were already gate-approved).

- [ ] **Step 2: Visual move-count audit**

Count the design moves on the rendered page (Centered Monument + limit bar + code blocks). Target 0–4, each earning its place. Confirm: no left-stripe cards, no gradient text, no uppercase eyebrows, no emoji, no over-containerization. If 5+, cut.

- [ ] **Step 3: Write a Playwright happy-path spec**

Inventory the existing Playwright setup first (`grep -rl "@playwright/test" dexter-fe`). Then create a spec asserting: `/tab` renders the headline, the "Open a Tab" CTA is present, clicking "For builders →" reveals the install snippet, the Copy button exists.

```ts
import { test, expect } from '@playwright/test';

test('tab page: hero + both doors reachable', async ({ page }) => {
  await page.goto('/tab');
  await expect(page.getByRole('heading', { name: /Open a tab once/i })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open a Tab' })).toBeVisible();
  await page.getByRole('button', { name: /For builders/i }).click();
  await expect(page.getByText('npm i @dexterai/vault')).toBeVisible();
});
```

- [ ] **Step 4: Run the Playwright spec**

Run: `cd /home/branchmanager/websites/dexter-fe && npx playwright test e2e/tab.spec.ts`
Expected: PASS.

- [ ] **Step 5: Production build + PM2 restart + live verify**

```bash
cd /home/branchmanager/websites/dexter-fe
npm run build
pm2 restart dexter-fe
```
Then with the laptop-browser skill, open the PRODUCTION URL `/tab` (dexter.cash/tab) and confirm it renders in the production build — both doors, real data on Door 1, working snippet on Door 2.

- [ ] **Step 6: Screenshot desktop AND iPhone-width**

With the laptop-browser skill, capture `/tab` at desktop width and at iPhone width (~390px). Confirm the Centered Monument holds on mobile (the most-seen launch surface; announcement traffic skews mobile). No horizontal scroll, CTA reachable, snippet scrolls within its block not the page.

- [ ] **Step 7: Commit**

```bash
cd /home/branchmanager/websites/dexter-fe
git add app/tab e2e/tab.spec.ts
git commit -m "test(tab): Playwright happy-path + anti-slop gate clean; verified in production build, desktop + mobile"
```

---

# PART 2 — SURFACE C step-1 (dexter-vault-sdk `./connect`). Execute AFTER Surface B.

## Task C1: The relying-app verifier (`@dexterai/vault/connect`)

**Files:**
- Create: `dexter-vault-sdk/src/connect/verify.ts`
- Create: `dexter-vault-sdk/src/connect/index.ts`
- Create: `dexter-vault-sdk/tests/connect-verify.test.ts`
- Modify: `dexter-vault-sdk/package.json` (add `./connect` export)
- Reference (read first): `dexter-vault-sdk/src/instructions/provePasskey.ts`, `dexter-vault-sdk/src/signers/browser/index.ts`, an existing subpath's `index.ts` (e.g. `src/tab/index.ts`) for the export pattern, and `tsup.config`/build config for how subpaths get wired.

- [ ] **Step 1: Read `provePasskey.ts` to learn the exact proof shape**

Read `src/instructions/provePasskey.ts` end-to-end. Identify: what a "proof" consists of (the WebAuthn assertion buffers + the passkey pubkey + the challenge), how the on-chain instruction verifies it (the secp256r1 precompile sibling + the op-message = the challenge), and what the verifier needs to reconstruct to confirm a proof. The challenge the relying app issues IS the message the passkey signs.

- [ ] **Step 2: Write the failing verifier test**

Create `dexter-vault-sdk/tests/connect-verify.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { verifyConnectProof } from '../src/connect/verify';

describe('verifyConnectProof', () => {
  it('accepts a valid prove_passkey proof and returns the verified vault identity', async () => {
    // Build a proof using the SAME machinery provePasskey/WebAuthnAssertion uses,
    // over a known challenge, for a known vault passkey. (Construct from a fixture
    // keypair so the test is deterministic and offline.)
    const { proof, expectedVault, challenge } = makeValidProofFixture();
    const result = await verifyConnectProof({ challenge, proof });
    expect(result.ok).toBe(true);
    expect(result.vault?.toBase58?.() ?? result.vault).toBe(expectedVault);
  });

  it('rejects a proof signed by the wrong passkey', async () => {
    const { proof, challenge } = makeForgedProofFixture(); // signed by a different key
    const result = await verifyConnectProof({ challenge, proof });
    expect(result.ok).toBe(false);
  });

  it('rejects a proof whose challenge does not match what was issued', async () => {
    const { proof } = makeValidProofFixture();
    const result = await verifyConnectProof({ challenge: 'a-different-challenge', proof });
    expect(result.ok).toBe(false);
  });
});
```

> IMPLEMENTER NOTE: `makeValidProofFixture` / `makeForgedProofFixture` build a real WebAuthn-style assertion over the challenge using the same P-256 path the on-chain program checks. Mirror how the existing SDK tests construct passkey assertions (search `tests/` for `WebAuthnAssertion` or `secp256r1`/`p256` usage and reuse that fixture builder). The verification must check the SAME fact the on-chain `prove_passkey` checks — the secp256r1 assertion over sha256(challenge) by the vault's passkey — NOT a weaker check.

- [ ] **Step 3: Run the test to confirm it fails**

Run: `cd /home/branchmanager/websites/dexter-vault-sdk && npx vitest run tests/connect-verify.test.ts`
Expected: FAIL ("verifyConnectProof is not a function" / module not found).

- [ ] **Step 4: Implement the verifier**

Create `dexter-vault-sdk/src/connect/verify.ts`. Two valid strategies (pick the one matching the existing codebase's tools — prefer pure-crypto if a P-256 verify util already exists in the SDK, else simulation):

(A) **Pure-crypto verify (preferred if available):** verify the secp256r1 WebAuthn assertion locally — confirm the assertion signs `sha256(authenticatorData || sha256(clientDataJSON))` where `clientDataJSON.challenge === base64url(issuedChallenge)`, against the vault's stored passkey pubkey. Reuse the SDK's existing P-256 verification helper (search `src/precompile` / `src/verify` / `src/signers`).

(B) **Simulation verify:** build the `prove_passkey` instruction via `provePasskey.ts` + the precompile sibling, and `simulateTransaction` against a mainnet RPC (Helius — NEVER mainnet-beta; read the RPC from the same env the SDK's other RPC users read, e.g. `getRpc` in `src/kit`). If simulation succeeds, the proof is valid.

```ts
import { PublicKey } from '@solana/web3.js';

export interface ConnectProof {
  passkeyPubkey: Uint8Array;     // 33-byte compressed P-256
  vault: string;                 // base58 vault PDA the proof claims
  clientDataJson: Uint8Array;
  authenticatorData: Uint8Array;
  signature: Uint8Array;         // the secp256r1 assertion
}

export interface ConnectVerifyResult {
  ok: boolean;
  vault?: PublicKey;
  reason?: string;
}

export async function verifyConnectProof(args: {
  challenge: string;
  proof: ConnectProof;
}): Promise<ConnectVerifyResult> {
  // 1. Confirm clientDataJSON.challenge === base64url(args.challenge) (replay/fixation guard).
  // 2. Verify the secp256r1 assertion over sha256(authenticatorData || sha256(clientDataJSON))
  //    against proof.passkeyPubkey — using the SDK's existing P-256 verify helper (strategy A)
  //    OR by simulating prove_passkey against Helius mainnet (strategy B).
  // 3. Confirm the passkey pubkey is the one bound to proof.vault (the on-chain Vault.passkey_pubkey).
  // Return { ok: true, vault: new PublicKey(proof.vault) } on success; { ok:false, reason } otherwise.
  // FULL implementation per the chosen strategy — no placeholder logic ships.
}
```

> IMPLEMENTER NOTE: this is the security boundary. The reject cases (wrong passkey, wrong challenge) MUST actually fail crypto verification, not a string compare you could bypass. If using strategy B, the RPC MUST be Helius mainnet (read from env the same way the rest of the SDK does); never hardcode mainnet-beta.

- [ ] **Step 5: Create the subpath barrel + wire the export**

Create `dexter-vault-sdk/src/connect/index.ts`:

```ts
export { verifyConnectProof } from './verify';
export type { ConnectProof, ConnectVerifyResult } from './verify';
```

Add to `dexter-vault-sdk/package.json` `exports` (mirror the `./tab` entry exactly):

```json
"./connect": {
  "types": "./dist/connect/index.d.ts",
  "import": "./dist/connect/index.js",
  "require": "./dist/connect/index.cjs"
}
```

Also add `src/connect/index.ts` as an entry in the build config (tsup) the same way `src/tab/index.ts` is registered — read the config and follow the pattern.

- [ ] **Step 6: Run the test to confirm it passes + tsc clean**

Run: `cd /home/branchmanager/websites/dexter-vault-sdk && npx vitest run tests/connect-verify.test.ts && npx tsc --noEmit`
Expected: 3 tests PASS, tsc clean.

- [ ] **Step 7: Commit**

```bash
cd /home/branchmanager/websites/dexter-vault-sdk
git add src/connect package.json tests/connect-verify.test.ts tsup.config.ts
git commit -m "feat(connect): @dexterai/vault/connect verifier — verifyConnectProof over prove_passkey assertion"
```

---

## Task C2: The "Connect a Tab" button + browser ceremony

**Files:**
- Create: `dexter-vault-sdk/src/connect/button.tsx` (the drop-in React component) OR a framework-agnostic `connectTab()` client call + a thin React wrapper — decide based on whether the SDK already ships React (check `package.json` peerDeps). If the SDK is framework-agnostic, ship `connectTab()` (the ceremony) in `src/connect/ceremony.ts` and keep the visual button as a copy-paste snippet in the C3 doc rather than a shipped component.
- Create: `dexter-vault-sdk/tests/connect-ceremony.test.ts`
- Reference: `dexter-vault-sdk/src/signers/browser/index.ts` (`WebAuthnAssertion`)

- [ ] **Step 1: Decide the shipping shape (read package.json peerDeps)**

Read `dexter-vault-sdk/package.json`. If React is NOT a dep/peerDep, do NOT add it — ship `connectTab()` (a pure browser function that runs the ceremony and returns a `ConnectProof`) from `src/connect/ceremony.ts`, and the *button* is a documented snippet (C3). If React IS already a peerDep, ship a `<ConnectTabButton>` too. DEFAULT to the framework-agnostic `connectTab()` — it keeps the SDK lean and the button is trivial for any app to wrap.

- [ ] **Step 2: Write the failing ceremony test**

Create `dexter-vault-sdk/tests/connect-ceremony.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { connectTab } from '../src/connect/ceremony';

describe('connectTab', () => {
  it('runs the WebAuthn ceremony over the issued challenge and returns a ConnectProof', async () => {
    // Mock navigator.credentials.get (or WebAuthnAssertion's underlying call) to
    // return a deterministic assertion fixture, mirroring how signers/browser is tested.
    const proof = await connectTab({ challenge: 'srv-challenge-123', vault: KNOWN_VAULT });
    expect(proof.vault).toBe(KNOWN_VAULT);
    expect(proof.signature.length).toBeGreaterThan(0);
    expect(proof.clientDataJson.length).toBeGreaterThan(0);
  });

  it('round-trips: connectTab output verifies via verifyConnectProof', async () => {
    const challenge = 'srv-challenge-123';
    const proof = await connectTab({ challenge, vault: KNOWN_VAULT });
    const { verifyConnectProof } = await import('../src/connect/verify');
    const result = await verifyConnectProof({ challenge, proof });
    expect(result.ok).toBe(true);
  });
});
```

> IMPLEMENTER NOTE: the round-trip test is the important one — it proves the button's output is exactly what the verifier accepts. Reuse the browser-signer test's mocking approach for `navigator.credentials` / `WebAuthnAssertion`.

- [ ] **Step 3: Run the test to confirm it fails**

Run: `cd /home/branchmanager/websites/dexter-vault-sdk && npx vitest run tests/connect-ceremony.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement `connectTab()`**

Create `dexter-vault-sdk/src/connect/ceremony.ts`:

```ts
import { WebAuthnAssertion } from '../signers/browser';
import type { ConnectProof } from './verify';

export async function connectTab(args: {
  challenge: string;       // issued by the relying app
  vault: string;           // base58 vault PDA being connected
}): Promise<ConnectProof> {
  // 1. Run WebAuthnAssertion over sha256(challenge) — the EXACT same browser P-256
  //    ceremony the rest of the SDK uses; it returns the 3 on-chain-ready buffers.
  // 2. Assemble ConnectProof { passkeyPubkey, vault, clientDataJson, authenticatorData, signature }.
  // 3. Return it for the relying app to hand to verifyConnectProof (C1).
  // FULL implementation using the existing WebAuthnAssertion API — read its signature.
}
```

- [ ] **Step 5: Export it from the barrel**

Add to `src/connect/index.ts`:

```ts
export { connectTab } from './ceremony';
```

- [ ] **Step 6: Run the tests + tsc**

Run: `cd /home/branchmanager/websites/dexter-vault-sdk && npx vitest run tests/connect-ceremony.test.ts && npx tsc --noEmit`
Expected: both tests PASS (including the round-trip), tsc clean.

- [ ] **Step 7: Verify the real browser ceremony (manual, laptop-browser)**

Build the SDK (`npm run build`), wire a throwaway local page that imports `connectTab` and calls it on a button click, and with the laptop-browser skill: click → real passkey prompt → proof returned. (This validates the ceremony fires the actual WebAuthn prompt, which a mocked unit test can't.) Screenshot the prompt.

- [ ] **Step 8: Commit**

```bash
cd /home/branchmanager/websites/dexter-vault-sdk
git add src/connect tests/connect-ceremony.test.ts
git commit -m "feat(connect): connectTab() browser ceremony — runs WebAuthnAssertion, returns verifier-ready ConnectProof; round-trip tested"
```

---

## Task C3: The integration contract (docs)

**Files:**
- Create: `dexter-vault-sdk/docs/connect-a-tab.md`
- Reference: `~/.claude/skills/dexter-anti-slop-prose/scripts/check.sh`

- [ ] **Step 1: Write the integration doc**

Create `dexter-vault-sdk/docs/connect-a-tab.md` — a short, minutes-to-adopt guide (the Connect-Wallet adoption bar). Cover: install (`npm i @dexterai/vault`), the relying-app server issues a random challenge, the client calls `connectTab({ challenge, vault })`, the server calls `verifyConnectProof({ challenge, proof })`, what it returns (the verified vault identity). Include a copy-paste "Connect a Tab" button snippet with the LOCKED copy:
- Button label: **"Connect a Tab"**
- Sub-copy/tagline: **"and your agent can pay here, up to a limit you set."**

End with a short "What's next: the spend grant" note pointing to C4 being a deliberate SECOND consent (do not imply auth grants spend).

- [ ] **Step 2: Anti-slop gate the doc**

Run: `bash ~/.claude/skills/dexter-anti-slop-prose/scripts/check.sh < dexter-vault-sdk/docs/connect-a-tab.md`
Expected: 0 hits. Fix and re-run until clean.

- [ ] **Step 3: Commit**

```bash
cd /home/branchmanager/websites/dexter-vault-sdk
git add docs/connect-a-tab.md
git commit -m "docs(connect): Connect-a-Tab integration contract — install, challenge, connectTab, verifyConnectProof; anti-slop clean"
```

---

## Task C4 (SPEC ONLY — DO NOT BUILD THIS WINDOW): the spend grant

**This task produces a SPEC FILE, not code.** Per GTM's locked sequencing: auth (C1–C3) builds now; the spend grant builds NEXT window; the public announcement waits until both exist (build split, announce once).

**Files:**
- Create: `dexter-vault-sdk/docs/superpowers/specs/2026-06-07-connect-spend-grant.md`

- [ ] **Step 1: Write the step-2 spec**

Design the step-2 contract: a relying app requests a bounded tab (counterparty, cap, expiry) → the user approves via a DELIBERATE second action (distinct click, distinct consent — never fused with C1's auth) → produces a `register_session_key`-scoped grant so the agent can pay THAT app within the bound. Reference the real `register_session_key` instruction + the SDK's session-registration builder. Note explicitly: auth (C1) and authorization (C4) are two consents; fusing them is the dark pattern the whole design rejects. Mark BUILD-NEXT, not this window.

- [ ] **Step 2: Commit the spec**

```bash
cd /home/branchmanager/websites/dexter-vault-sdk
git add docs/superpowers/specs/2026-06-07-connect-spend-grant.md
git commit -m "docs(connect): SPEC for step-2 spend grant (build-next; auth and authorization stay separate consents)"
```

---

## After all tasks

- [ ] Dispatch a final holistic code reviewer over the entire B+C diff (both repos).
- [ ] Report to Branch: B live at `/tab` (verified rendering, desktop+mobile, real data); C `./connect` built+committed+tested in the SDK but NOT published (gated); C4 spec written, build-next.
- [ ] Notify GTM via agent-mail: Surface B is live, Surface C step-1 is built (un-published), the announcement stays held until step-2 (C4) ships per the locked sequencing.
- [ ] Open decision still pending for Branch (does not block): host `dexter.cash/tab` vs `tab.dexter.cash` (decide before any DNS/deploy beyond the PM2 restart).

---

## Self-Review (run by the plan author, not a subagent)

**Spec coverage (B):** B0 surfaces live session spent+limit through dexter-api→fe so the hero's limit bar shows REAL spend (Branch's decision — "add the API field first") ✓. B1 scaffold+toggle+hero ✓ (spec "one page, two doors, audience-toggled" + Centered Monument). B2 consumer flow reusing real components + vault→tab relabel + trust-spine enforcement line + live limit bar ✓. B3 builder door with verbatim README snippet ✓. B4 anti-slop + Playwright + PM2 + desktop/mobile render verify ✓. Host decision surfaced as non-blocking ✓.

**Spec coverage (C):** C1 verifier ✓ (spec Task C1). C2 button/ceremony ✓ (Task C2). C3 integration doc ✓ (Task C3). C4 spec-only ✓ (Task C4, explicitly not built). Two-consent separation enforced in C3 + C4 ✓. Announce-once sequencing noted in the after-tasks ✓. `./connect` subpath (Branch's choice over `./siwx`) ✓.

**Placeholder scan:** The two `IMPLEMENTER NOTE` blocks point at REAL ambiguities the implementer must resolve by reading source (the vault-identity helper in `wallet/page.tsx`; the spent/limit field availability on `VaultStatus`; the pure-crypto-vs-simulation verify strategy; the React-vs-agnostic shipping shape). These are not lazy placeholders — they are "read the source, don't assume" directives with the exact files named, because the plan author cannot know the fe identity-resolution internals or the exact P-256 helper without the implementer reading them. The `OPEN_TAB_SNIPPET` and `readLocalVaultIdentity` are explicitly flagged as "replace with the real thing from <named file>."

**Type consistency:** `ConnectProof` defined in C1 `verify.ts`, consumed identically in C2 `ceremony.ts` and the C2 round-trip test. `verifyConnectProof({ challenge, proof })` and `connectTab({ challenge, vault })` signatures consistent across C1/C2/C3. `VaultAccountCard` props (`status`, `balance`, `balanceLoading`, `reconcile`) match the real component signature read from source. `TabLimitBar({ spent, limit })` consistent between B2 step-2 and step-3.

**Residual risk — RESOLVED before execution:** the original concern was that the fe had no `spent`/`limit` data. I traced it to source: the on-chain `SessionRegistration` holds `spent` + `max_amount`, the SDK reader's `readVaultFull()` ALREADY decodes them (`accountReader.ts:130-138`), and dexter-api's `resolveVaultState.ts` simply called the slim reader and dropped them. B0 closes the gap (slim→full read, two fields through to fe). The bar now shows real on-chain spend; when there's no active session both fields are null and `TabLimitBar` renders nothing — no fabrication. The one true backend dependency in the critical path is B0's `pm2 restart dexter-api` (a live service) — flagged, not hidden.

**Also corrected pre-execution:** the `useVaultBalance` first arg is `receiveAddress ?? swigAddress` (the swig wallet PDA), NOT `vaultPda` — verified against `wallet/page.tsx:57-60`. The earlier draft would have read $0.
