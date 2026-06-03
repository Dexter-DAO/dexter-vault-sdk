# Changelog

All notable changes to `@dexterai/vault`.

## 0.1.1 — 2026-06-03

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
