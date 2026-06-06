# Changelog

All notable changes to `@dexterai/vault`.

## 0.4.2 — 2026-06-06

### Added

- **LockedClaim instruction builders** — client-side builders for the four LockedClaim instructions deployed on the dexter-vault program (the credit-claim "crystallized" tier). Exposed via `@dexterai/vault/instructions`:
  - `buildLockVoucherInstruction` — crystallize an accepted voucher into a transferable, buyer-irrevocable on-chain claim (10 accounts; derives the claim PDA + swig-wallet PDA).
  - `buildSettleLockedVoucherInstruction` — the claim holder (financier) collects the USDC.
  - `buildTransferLockOwnershipInstruction` — sell/transfer a claim to a new holder.
  - `buildRecoverAbandonedLockInstruction` — buyer reclaims after the holder-recovery deadline.
  - `deriveLockedClaimPda(vaultPda, voucherHash)` — derive the claim PDA (`[LOCKED_CLAIM_SEED, vault, voucher_hash]`).
- `LOCKED_CLAIM_SEED` and the four LockedClaim Anchor discriminators in `constants`.
- Byte-parity tests for all four builders (account order, signer/writable flags, arg layout, `Option<i64>` Borsh encoding, claim-PDA derivation) plus discriminator pinning against hardcoded literals.
- Account-list updates to `register_session_key` (2→5 accounts) and `finalize_withdrawal` (4→5 accounts: adds `vault_usdc_ata`) to match the deployed program's Phase 1 reservation/overcommit gates.
- Refreshed the bundled `idl/dexter_vault.json` to the current program (now includes the LockedClaim instructions).
- **Factoring / instant-payout** (`@dexterai/vault/factoring`) — `computeFactoringSplit` (pure split math) + `buildInstantPayoutInstructions` (settles a LockedClaim and splits the payout: seller gets instant cash, financier keeps the spread — one atomic `settle_locked_voucher` + Swig SignV2). The spread is caller-supplied (neutral mechanism; operator sets policy). Fully wired against `@swig-wallet/kit` + `@solana-program/token`.

This is additive; prior consumers continue to work unchanged.

## 0.2.1 — 2026-06-04

### Added

- `WebAuthnAssertionResult.signatureDer` — raw DER-encoded ECDSA signature as returned by the authenticator, exposed alongside the existing compact-lowS `signature`. Consumers composing the SDK with a server-policy verify leg (Dexter's `DexterApiBrowserPasskeySigner`, partner equivalents) need DER to feed WebAuthn server libraries like `@simplewebauthn/server`, which expect the authenticator's original DER bytes — not the compact form. The on-chain bytes remain `signature` (compact); DER is for server-side verify only.

This is additive; v0.2.0 consumers continue to work unchanged.

## 0.2.0 — 2026-06-03

### Added

- **`@dexterai/vault/signers/browser`** — new subpath. Exports the `WebAuthnAssertion` class: pure-browser P-256 passkey ceremony. Runs `navigator.credentials.get()` over a caller-supplied challenge and returns the three on-chain-ready buffers: a 64-byte compact lowS r||s signature, raw `clientDataJSON`, raw `authenticatorData`. Zero `fetch` calls. The class implements the v0.1 `PasskeySigner` interface; consumers compose it with their own server-policy adapter.
- **`derSignatureToCompactLowS`** exported from `signers/browser` — the canonical implementation. Lifts verbatim from dexter-fe's `passkey.ts:253-313` (and its byte-identical twin in `passkey-anon.ts`). After dexter-fe swaps in this release, those two copies go away.
- 12 new tests in `tests/signers/browser.test.ts` — DER → compact lowS byte-parity snapshots (low-S + high-S + padding cases), invalid-DER rejection cases, `assertOver` happy path with a mocked `navigator.credentials.get`, `not_browser` / `invalid_challenge` / `user_cancelled` guards. Brings the suite to 78 tests, 7 files.

### What this unlocks

dexter-fe is the last consumer that hand-rolls the on-chain byte layouts. The v0.2 release adds the browser-side primitive; the dexter-fe swap (writing a ~40-line `DexterApiBrowserPasskeySigner` adapter that composes `WebAuthnAssertion` with its existing `/api/passkey[-anon]/sign/{challenge,verify}` round-trips) ships in dexter-fe next, then the demo queue opens.

## 0.1.3 — 2026-06-03

### Fixed

- **CJS bundle broke `buildSwigCreationBundle` for any non-ESM consumer.** `bs58@6` ships as a CJS module whose `module.exports` is `{ default: <bs58 instance> }`. esbuild/tsup's CJS interop double-wraps that, so `dist/instructions/index.cjs` emitted `bs58.decode(...)` calls that resolved to `undefined`. Source now imports the namespace and peels one `.default` layer at runtime — identical behavior under ESM (unchanged) and CJS (fixed). Discovered while swapping dexter-vault tests; the workaround in their commit `5798f83` can now revert to a static import.

## 0.1.2 — 2026-06-03

Re-publish of 0.1.1 contents under a new version number. The 0.1.1 tag was unpublished from npm earlier the same day during a brief privacy-posture experiment; npm policy blocks reusing the same version number for 24 hours after an unpublish, so this is the same bytes under a bumped patch. No code or test changes from 0.1.1.

## 0.1.1 — 2026-06-03 (unpublished, see 0.1.2)

### Added

- Dexter-DAO-style README — wordmark hero, badges, runnable quick-start blocks, full subpath table.
- `assets/dexter-wordmark.svg` shipped with the package so the README hero renders on npmjs.com as well as GitHub.
- `tests/precompile.test.ts` — byte-parity snapshots for `buildSecp256r1VerifyInstruction`, `buildEd25519VerifyInstruction`, and `buildPrecompileMessage`. Locks the SIMD-0075 offsets table and the `authenticatorData || SHA-256(clientDataJSON)` assembly.
- `tests/swigBundle.test.ts` — structural smoke for `buildSwigCreationBundle`: produces ≥4 instructions, idempotent for the same `(identitySeed, hmacKey)`, distinct outputs for different inputs, exec-marker bytes match the on-chain `settle_tab_voucher` discriminator, rejects wrong-length HMAC key.
- `settle_voucher` (legacy counter instruction) data + keys snapshot in `tests/byte-parity.test.ts`.

### Test count

- 0.1.0: 45 tests, 4 files
- 0.1.1: 66 tests, 6 files (+21 tests; +precompile.test.ts, +swigBundle.test.ts)

## 0.1.0 — 2026-06-03

Initial release. Extracted from `dexter-api/src/vault/`, `dexter-facilitator/src/vault/`, and `dexter-x402-sdk/src/tab/`. Compatible with `dexter-vault` program version 2 (12 Anchor discriminators including `prove_passkey`, `settle_tab_voucher`, and the session-key register/revoke pair).
