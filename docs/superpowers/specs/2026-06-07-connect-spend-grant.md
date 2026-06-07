# Design Spec: Connect a Tab, Step 2 (The Spend Grant)

**Date:** 2026-06-07
**Author:** vault SDK design agent (Task C4), for Branch's review
**Status:** SPEC, build-next (step 2 of Connect a Tab). The auth half shipped C1-C3. Announcement gated on this shipping.

## Goal

Spec the second consent of "Connect a Tab": a deliberate, separate user action that grants ONE relying app a bounded spending tab on the user's vault, mapped onto the live on-chain `register_session_key` instruction.

---

## 1. Where this sits

"Connect a Tab" has two consents, by design separate:

| Step | Status | What it does | What it grants |
|---|---|---|---|
| **1, auth** | SHIPPED (C1-C3) | `connectTab()` runs a passkey assertion; `verifyConnectProof()` checks a `prove_passkey` proof. Proves the user controls a named vault. | Identity. **No spending.** |
| **2, spend grant** | THIS SPEC, build-next | A second, deliberate passkey ceremony endorsing a `register_session_key` registration scoped to one counterparty. | The user's agent can pay THAT app, up to a cap, until an expiry. |

Step 1 answers "is this user's vault real and theirs?" Step 2 answers "may this app's tab be paid from that vault, and how much?" They are different questions and they get different clicks.

The auth half already exists in `src/connect/` (`ceremony.ts`, `verify.ts`, `index.ts`). This spec covers the additions that turn an authenticated connection into a payable one.

---

## 2. The two-consent model (and why it is two)

Two separate clicks, two consents. Fusing auth and authorization into one ceremony is the dark pattern this whole design rejects: a user who proves they own a vault has NOT thereby agreed to let an app spend from it. "Sign in with vault" must not silently mean "and here is my money." The spend grant is the step where the agent BECOMES able to pay the app, and it stays a distinct, reviewable decision with its own scope screen and its own biometric prompt.

Build split, announce once. The two halves ship in separate windows (auth shipped C1-C3; the spend grant builds next). The public announcement of "Connect a Tab" holds until both exist, so the story lands as one coherent flow rather than half a feature.

---

## 3. The user flow (step 2)

Precondition: a successful Connect (step 1). The relying app knows it is talking to a real vault the user controls.

1. **App proposes a bounded tab.** After Connect, the app requests a tab by proposing a scope:
   `{ counterparty = the app's own settlement address, cap = max USDC, expiry, revolving capacity }`. The app proposes; it cannot grant.
2. **User reviews the scope.** Which app (the counterparty address, surfaced as the app's identity), how much (the cap), until when (the expiry), and the revolving headroom. This is the screen the consent is about.
3. **User approves via a deliberate second action.** A passkey ceremony over the session-registration message. This biometric prompt is distinct from the auth assertion in step 1: a different message, signed for a different reason.
4. **Output: a `register_session_key` grant** on the user's vault, with `allowed_counterparty` set to that app. From here, the user's agent can pay that app within the bound via the existing tab/settle path, and ONLY that app. A voucher naming any other counterparty is rejected by the seller's verification path; the on-chain `allowed_counterparty` is the binding.

---

## 4. How it maps to the on-chain primitive

The spend grant is not new machinery. It IS a `register_session_key` call, an instruction already deployed on mainnet. The proposed scope maps directly onto `RegisterSessionKeyArgs` (`register_session_key.rs:52-78`):

| Requested scope field | `RegisterSessionKeyArgs` field | Notes |
|---|---|---|
| the app's settlement address | `allowed_counterparty: Pubkey` | **The scoping.** Binds the whole grant to one counterparty. This is what makes "grant THIS app a tab" mean only that app. |
| cap (max USDC) | `max_amount: u64` | Cumulative cap in USDC base units (6 decimals). Program rejects `max_amount == 0` (`SessionCapZero`). |
| expiry | `expires_at: i64` | Unix seconds, must be strictly future (`SessionExpiryInPast`). |
| revolving headroom | `max_revolving_capacity: u64` | Cap the revolving meter (`current_outstanding`) is checked against. Program rejects `0` (`RevolvingCapacityZero`). May be `<= max_amount`. |
| (SDK-generated) | `session_pubkey: [u8; 32]` | Ephemeral ed25519 key the buyer SDK generates in memory; the standard tab session key. The passkey endorses THIS exact key. |
| (SDK-chosen) | `nonce: u32` | Per-session replay fingerprint. Program does not enforce monotonicity (caller's footgun, not a protocol attack; see handler comment). |
| (ceremony output) | `client_data_json`, `authenticator_data` | WebAuthn ceremony bytes. The passkey signature is what authorizes the mutation; the accounts struct requires no signer. |

What the passkey signs is the 188-byte registration message built by `sessionRegisterMessage()` (`src/messages/session.ts:42`), which is byte-identical to the on-chain `build_registration_message` (`register_session_key.rs:175`). Layout: domain `OTS_SESSION_REGISTER_V2` ‖ program_id ‖ vault_pda ‖ session_pubkey ‖ max_amount ‖ expires_at ‖ allowed_counterparty ‖ nonce ‖ max_revolving_capacity. Any drift makes the signature look forged on-chain.

The transaction itself is assembled by `buildRegisterSessionKeyInstruction()` (`src/instructions/registerSession.ts:88`), whose `BuildRegisterSessionKeyArgs` already takes every field above plus `vaultPda`, `swigAddress`, and `vaultUsdcAta` (the swig USDC ATA, read on-chain for the overcommit gate, where the program checks `max_amount + outstanding_locked_amount <= ATA balance`). The spend-grant surface composes this builder; it does not reimplement the encoding.

Resulting on-chain state: a `SessionRegistration` (`state.rs:102`) in `vault.active_session`, carrying `session_pubkey`, `max_amount`, `expires_at`, `allowed_counterparty`, `nonce`, `spent` (0), `current_outstanding` (0), `max_revolving_capacity`. The pair `current_outstanding` vs `max_revolving_capacity` is the live exposure meter the settle path moves.

---

## 5. Proposed SDK surface (design, not built)

A sketch for two new functions under `@dexterai/vault/connect`, one per side. Exact signatures are the build-next task's job; the rationale is what matters here.

**Relying-app side, `requestSpendGrant(...)`.** Given the app's settlement address and the bound it wants (cap, expiry, revolving capacity), produces a serializable grant-request the app hands to the browser. It proposes scope; it holds no key and signs nothing. Rationale: keep the proposing party (server) cleanly separated from the approving party (user's browser), mirroring the step-1 split where the app issues a challenge and the user proves over it.

**Browser / user side, `approveSpendGrant(...)` (alt: `grantTab(...)`).** Given the grant-request plus the vault context (vault PDA, passkey credential, the SDK-generated ephemeral `session_pubkey`, swig address, USDC ATA), it:
1. builds the 188-byte registration message via `sessionRegisterMessage()`,
2. runs the passkey ceremony over it (the deliberate second consent),
3. composes the `register_session_key` instruction via `buildRegisterSessionKeyInstruction()` with the ceremony output.

Return shape: **instructions, not a sent transaction.** Recipe-not-kitchen, consistent with the rest of the SDK: the function returns the `register_session_key` instruction(s) and the caller sends them. The browser side never gets a "broadcast" capability it does not need.

Naming note: `approveSpendGrant` reads truthfully (the user is approving a thing the app requested). `grantTab` is shorter and pairs with "Connect a Tab." Pick at build time; flagged in open questions.

---

## 6. The `SessionAlreadyActive` constraint (the hard part)

The program rejects a second active session per vault: if `vault.active_session` exists and is unexpired, `register_session_key` fails with `SessionAlreadyActive` (`register_session_key.rs:126-129`). An EXPIRED session is silently overwritten; that is how sessions rotate. This is the v2 single-session limit, and it holds firm: **one active spend grant per vault at a time.**

So "connect a tab at app A, then app B" does NOT work today by stacking two grants. The honest options:

- **(A) v1 is single-counterparty-at-a-time (ship this).** A vault has at most one active spend grant. Granting app B while app A's grant is active requires the user to revoke A first (`revoke_session_key` exists; see `sessionRevokeMessage`, a 128-byte revoke ceremony). The SDK surfaces the conflict plainly: `approveSpendGrant` detects an active session and either errors with a clear "you already have an active tab with <counterparty>, revoke it to grant a new one" or offers a revoke-then-register path (a two-ceremony flow: revoke A, register B). Pro: ships on the deployed program, no on-chain change. Con: a user can only have ONE app's tab active at once, a product limit that needs clear UX, not a hidden one.
- **(B) replace-on-grant.** `approveSpendGrant` to a new counterparty automatically revokes the prior session and registers the new one in the same flow. Pro: "connect at B" just works from the user's view. Con: silently kills the user's tab at A, a footgun if A is mid-stream, and it muddies the consent (the user approved B, not the teardown of A). If chosen, the teardown MUST be shown in the scope review, not done silently.
- **(C) multi-session, the eventual fix, deferred.** Let a vault hold N concurrent sessions, one per counterparty (an array/PDA-per-counterparty instead of a single `Option<SessionRegistration>`). This is the natural shape for "tabs at many apps at once," but it is an on-chain program change (state layout, the overcommit gate must sum across sessions, migration). Tracked as issue #5 (future). NOT in scope for the spend-grant build.

**Recommendation to surface to Branch:** v1 ships option (A): single active grant, explicit revoke-to-switch, clear UX about the limit. Option (C) is the eventual answer once multi-session lands; (B) is a convenience layer over (A) that we should only build if we are comfortable making teardown-of-A part of the grant-B consent screen. Do not silently auto-revoke.

---

## 7. Security / consent properties

- **Passkey-endorsed scope.** The user's biometric approves the exact 188-byte registration message: the precise `max_amount`, `expires_at`, `allowed_counterparty`, and `session_pubkey`. The endorsement is over the scope, not a blank check.
- **On-chain enforcement at settle.** The cap (`max_amount` vs `spent`), the expiry (`expires_at`), the revolving meter (`current_outstanding` vs `max_revolving_capacity`), and the counterparty (`allowed_counterparty`) are all checked at settle time, on-chain and by the seller's verification path. The grant cannot be stretched past what the passkey signed.
- **Memory-only session key.** `session_pubkey` is an ephemeral ed25519 key the buyer SDK generates in memory for the duration of the tab. It does not persist and cannot be exfiltrated into a broader-spend grant; a leaked session key still only signs vouchers within the on-chain bound, against one counterparty, until expiry. The SDK never holds a key that can overspend the cap; overspend would require a fresh passkey ceremony.
- **Scoped blast radius.** Because `allowed_counterparty` binds the grant, a compromised session key cannot pay anyone but the one app named in the grant.

---

## 8. Out of scope (build-next task) + open questions

**Explicitly out of scope for the spend-grant build:**
- Multi-session / concurrent grants per vault (option C, issue #5); on-chain change, separate track.
- Any change to the on-chain program. The spend grant uses `register_session_key` as-is.
- The settle/voucher path itself (already exists; the grant feeds it).
- Seller-side verification changes (the seller already enforces counterparty/cap/expiry).

**Open questions for Branch:**
1. **Single-session resolution (§6):** confirm v1 ships option (A): one active grant, explicit revoke-to-switch. Is replace-on-grant (B) wanted as a convenience, and if so, do we accept showing the teardown-of-A in the grant-B consent screen?
2. **Cap semantics:** is the cap purely per-grant (`max_amount` on this one session), which it is today, or do we ever want a vault-wide spend ceiling across grants? (Moot under single-session; becomes real under multi-session.)
3. **Revolving vs one-shot:** the program requires `max_revolving_capacity > 0`. Do we expose revolving capacity as a first-class user-set knob in the scope screen, or default it (e.g. equal to `max_amount` for a non-revolving one-shot tab) and only surface it for revolving tabs?
4. **Naming:** `approveSpendGrant` vs `grantTab` for the browser-side function.
5. **Expiry defaults:** does the app propose the expiry, the user pick it, or both (app proposes a max, user can shorten)?
