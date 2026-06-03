# @dexterai/vault

The canonical off-chain mirror of the dexter-vault Solana Anchor program.

This package owns every TypeScript file in the Dexter codebase that
produces bytes the on-chain program will verify. If you are about to
hand-roll an instruction builder, a precompile message, a Swig role list,
or a vault account decoder, stop and import from here instead.

## Install

```bash
npm install @dexterai/vault
```

## Why this package exists

Three places used to hand-roll the same protocol. Drift was the default.
This package is the structural fix: there is exactly one TypeScript file
that knows how to build each instruction, encode each message, decode
the vault account, and provision the canonical 4-role Swig.

## Version coupling

`@dexterai/vault@0.1.x` is compatible with dexter-vault program version 2
(10 vault instructions plus 2 session-key instructions
(`register_session_key`/`revoke_session_key`) — 12 total Anchor
discriminators; role 3 ProgramExec for `settle_tab_voucher`). Future
program versions will bump the SDK major or have their delta documented
in CHANGELOG.

## Subpath exports

- `@dexterai/vault` — types + counterfactual derivation
- `@dexterai/vault/types` — `VaultState`, `ActiveSession`, `PendingWithdrawal`, `SessionKey`, `SessionScope`, `SignedVoucher`, `VoucherPayload`
- `@dexterai/vault/constants` — program IDs, USDC mint, all 12 discriminators
- `@dexterai/vault/instructions` — every builder; the canonical `buildSwigCreationBundle`
- `@dexterai/vault/messages` — `sessionRegisterMessage` (180 bytes), `sessionRevokeMessage` (128 bytes), `voucherPayloadMessage` / `buildVoucherMessage` (44 bytes), `buildSetSwigOperationMessage`
- `@dexterai/vault/reader` — `readVaultOnchain` (slim), `readVaultFull` (with active session)
- `@dexterai/vault/precompile` — `buildSecp256r1VerifyInstruction`, `buildPrecompileMessage`, `buildEd25519VerifyInstruction`
- `@dexterai/vault/signers` — `Ed25519Signer`, `PasskeySigner` interfaces
- `@dexterai/vault/signers/node` — `NodeEd25519Signer` (tweetnacl-backed)

## Known gaps (v0.1)

- **No `BrowserPasskeySigner`.** v0.1 ships the `PasskeySigner` interface
  but no implementation. dexter-fe continues to hand-roll WebAuthn until
  v0.2 (tracked as task #235). Lift target: `dexter-fe/app/lib/passkey.ts`
  + `dexter-fe/app/lib/passkey-anon.ts`. AAGUID/UA capture must survive
  the lift.

## Byte-parity guarantee

`tests/byte-parity.test.ts` (added in v0.1 build, see Task 3 of the extract plan) snapshots:
- All 12 instruction discriminators (10 vault + 2 session-key)
- All 3 message layouts (180-byte registration, 128-byte revocation, 44-byte voucher)
- The canonical vault account decode (v2 layout)
- The counterfactual Swig derivation for a known seed

Any change to any of these requires an explicit snapshot update —
flipping a byte by accident fails CI.
