<p align="center">
  <img src="https://raw.githubusercontent.com/Dexter-DAO/dexter-vault-sdk/main/assets/dexter-wordmark.svg" alt="Dexter" width="360">
</p>

<h1 align="center">@dexterai/vault</h1>

<p align="center">
  <strong>The off-chain mirror of the dexter-vault Anchor program.</strong> Byte-precise instruction builders, message encoders, account decoders, and signer abstractions for the passkey-rooted vault.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@dexterai/vault"><img src="https://img.shields.io/npm/v/@dexterai/vault.svg" alt="npm"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E=18-brightgreen.svg" alt="Node"></a>
  <a href="https://solscan.io/account/Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc"><img src="https://img.shields.io/badge/program-Hg3wRayd…2fhc-blueviolet" alt="Vault program"></a>
</p>

> **Building an app?** Reach for **[`@dexterai/x402`](https://www.npmjs.com/package/@dexterai/x402)** instead: it gives your agent a spending limit in a few lines, both the buyer and seller sides, and depends on this package transitively. Come to `@dexterai/vault` when you assemble your own vault transactions: a facilitator, a custom settlement path, or a second Open Tabs Standard implementation. This is the engine, not the front door.

---

## Why this package exists

Three places used to hand-roll the same protocol: `dexter-api/src/vault/`, `dexter-facilitator/src/vault/`, and `dexter-vault/tests/`. One of them registered role 3 (`ProgramExec` for `settle_tab_voucher`); two did not. The end-to-end tab-settle smoke kept failing with `Role not found for ID: 3`, and it ate hours of debugging on 2026-06-02 before anyone caught the drift.

This package is the structural fix. The canonical 4-role Swig provisioner, every instruction builder, every byte-precise message encoder, the vault account decoder, and the precompile helpers each live in exactly one file. Every consumer (`dexter-api`, `dexter-facilitator`, `dexter-vault` tests, `@dexterai/x402/tab`) imports from here. The drift bug class is gone.

If you are about to hand-roll a vault instruction builder, a precompile message, a Swig role list, or a vault account decoder, **import from here instead.**

---

## Install

```bash
npm install @dexterai/vault
```

Targets the `dexter-vault` V6 program: 26 pinned Anchor discriminators (`prove_passkey`, `settle_tab_voucher`, the session register/revoke pair, the LockedClaim set, the credit set `open_standby` / `draw_credit` / `repay_credit` / `seize_collateral`, and the `migrate_v5_to_v6` pair), with per-counterparty SessionAccount PDAs. V5 vaults are not decodable by 0.10.x; migrate them with the `migrate_v5_to_v6` builders.

## The byte contract

Every byte the on-chain program checks lives here, in exactly one file each: instruction discriminators, the 188-byte V2 session-registration message, the 128-byte revocation message, the 44-byte voucher payload, and the vault + SessionAccount account layouts. The `dexter-vault` program is the source of truth; this package is the TypeScript that talks to it, with byte-parity locked by snapshot tests (see below). A programmatic Swig role makes the non-custodial spend path possible, and the entire spend path goes through the vault program, with no master key, no escrow, and no trust.

---

## Provision a vault (server-side enrollment)

```typescript
import { buildSwigCreationBundle } from '@dexterai/vault/instructions';
import { Transaction } from '@solana/web3.js';

// Fee-payer-signed; this bundle creates the Swig and registers all four roles
// in one transaction (CreateV1 with role 0 bootstrap + role 1/2/3 chained).
const bundle = await buildSwigCreationBundle({
  feePayer: feePayerKeypair.publicKey.toBase58(),
  dexterMasterPubkey: sessionMaster.publicKey.toBase58(),
  identitySeed: userHandleBytes,           // per-user, stable, ≤32 bytes
  hmacKey: serverSecret.subarray(0, 32),   // 32-byte HMAC key
});

const tx = new Transaction().add(...bundle.instructions);
```

The 4-role design (role 0 bootstrap, role 1 `ProgramExec(finalize_withdrawal)`, role 2 session master, role 3 `ProgramExec(settle_tab_voucher)`) lives in exactly one function. Tests in this repo lock the role list against the on-chain Anchor discriminators.

## Settle a tab voucher (facilitator-side)

```typescript
import { buildSettleTabVoucherInstruction } from '@dexterai/vault/instructions';
import { buildEd25519VerifyInstruction } from '@dexterai/vault/precompile';
import { buildVoucherMessage } from '@dexterai/vault/messages';
import { readVaultFull } from '@dexterai/vault/reader';

const vaultState = await readVaultFull(connection, vaultPda);
const voucherMessage = buildVoucherMessage(channelId, cumulativeAmount, sequenceNumber);

const tx = new Transaction().add(
  // Ed25519 precompile verifies the session key signed the voucher bytes.
  buildEd25519VerifyInstruction(sessionPubkey, sessionSignature, voucherMessage),
  // settle_tab_voucher consumes the verified voucher; Swig role 3 drives the SPL transfer.
  // allowedCounterparty names the per-counterparty session PDA being settled against.
  buildSettleTabVoucherInstruction({
    vaultPda,
    swigAddress: new PublicKey(vaultState.swigAddress!),
    dexterAuthority: sessionMaster.publicKey,
    allowedCounterparty,
    channelId,
    cumulativeAmount,
    sequenceNumber,
  }),
);
```

## Read vault state

```typescript
import { readVaultOnchain, readVaultFull } from '@dexterai/vault/reader';
import { fetchSessionAccount, isSessionLive } from '@dexterai/vault/session';

// Slim shape: { exists, pendingVoucherCount, pendingWithdrawal }.
const slim = await readVaultOnchain(connection, vaultPda);

// Full shape adds: { version, swigAddress, dexterAuthority, liveSessionCount }.
const full = await readVaultFull(connection, vaultPda);

// V6: per-counterparty session state lives in its own PDA, not in the vault.
const s = await fetchSessionAccount(connection, vaultPda, allowedCounterparty);
if (s && isSessionLive(s)) {
  console.log(`tab open: ${s.session.spent} / ${s.session.maxAmount}`);
}
```

## Read crystallized claims (the reservation tier)

A voucher can be **crystallized** into a `LockedClaim`: an irreversible, buyer-unwithdrawable reservation of the spent amount. The vault tracks the running sum in `outstanding_locked_amount`, surfaced by `readVaultFull` as `outstandingLockedAmount`. This is the reservation that backs lock-mode tabs — the standard tab protection as shipped, surgically reserving only the accrued amount rather than freezing the whole wallet.

```typescript
import { readVaultFull, fetchVaultLockedClaims, decodeLockedClaim } from '@dexterai/vault/reader';

// Vault-level total: the sum the withdrawal gate reserves out of the balance.
const { outstandingLockedAmount } = await readVaultFull(connection, vaultPda);

// Per-claim detail. Each claim is a terminal state machine: Pending → Settled
// or Pending → Abandoned. Filter to the live (unsettled) reservations.
const pending = await fetchVaultLockedClaims(connection, vaultPda, { status: 'Pending' });
// reconciliation invariant: sum(pending.amount) === outstandingLockedAmount
for (const c of pending) {
  console.log(`${c.voucherHash}: ${c.amount} held by ${c.currentHolder} (${c.status})`);
}

// decodeLockedClaim(address, accountData) decodes a single account you already
// hold — the same moving-cursor decoder fetchVaultLockedClaims uses internally.
```

## Derive the counterfactual Swig address

```typescript
import { deriveCounterfactualAddresses } from '@dexterai/vault/counterfactual';

// Returns both the state PDA (program-owned) and the wallet-address PDA
// (system-owned, the asset holder). Useful for showing a deposit address
// before the Swig is on chain.
const { swigStateAddress, swigWalletAddress } = await deriveCounterfactualAddresses({
  identitySeed: userHandleBytes,
  hmacKey: serverSecret.subarray(0, 32),
});
```

---

## Sessions: one tab per counterparty

Each session lives in its own SessionAccount PDA, `[b"session", vault, allowed_counterparty]`: one tab per (vault, counterparty), many counterparties per vault. Registering against a counterparty that already has a session **replaces it in place** (same seed) and **resets the meters** (`spent`, `currentOutstanding`); anything building UX on top should warn before replacing.

Registering requires the sibling contract: the program checks that the transaction names every other version≠0 session of the vault, so it can sweep expired ones and prove the new cap does not overcommit the vault's balance.

```ts
import { buildRegisterSessionKeyInstruction, buildRevokeSessionKeyInstruction } from '@dexterai/vault/instructions';
import { fetchVaultSessionAccounts, sessionPdasOf, waitForSession } from '@dexterai/vault/session';

// fetch siblings FRESH immediately before building (the gate sweeps expired
// siblings; a stale list fails the on-chain completeness check)
const siblings = sessionPdasOf(await fetchVaultSessionAccounts(connection, vaultPda));
const ix = buildRegisterSessionKeyInstruction({ ...args, payer, siblingSessionPdas: siblings });
// ... send [secp256r1Precompile, ix] ...
await waitForSession(connection, vaultPda, allowedCounterparty, { expectedSessionPubkey });
```

The builder handles the fiddly parts of the sibling list (excludes the target, dedups, sorts strict-ascending by raw bytes, marks all writable); your only job is fetching it fresh. `waitForSession` is content-aware confirm-visibility: it waits for the **new** `session_pubkey`, because on a replace the old registration also passes existence and version checks under read-your-writes lag.

## Credit primitives

The vault program supports a tab that spends **past** the user's balance, backed by a financier's standby capital, structured so the buyer cannot rug the financier and the financier cannot seize more than the agreed bound. The builders for that path live here:

```ts
import { drawCredit, repayCredit, seizeCollateral } from '@dexterai/vault/tab';
```

Credit is not a separate product. It is a tab that can spend past its balance, so it composes the same primitives: `open_standby` arms the backing, `draw_credit` / `repay_credit` move the borrowed balance, `seize_collateral` runs the default path, and the LockedClaim crystallized tier (`@dexterai/vault/instructions`) plus factoring / instant payout (`@dexterai/vault/factoring`) build on top. Demonstrated on Solana mainnet: a draw, a repayment, and a default-and-seize. This is the newest surface in the package; treat it accordingly.

## Spend grants (`@dexterai/vault/grant`)

An app proposes a bounded spend-tab; the user's passkey endorses the exact 188-byte registration scope. Two halves:

```ts
// App side: produce a self-contained request blob (no keys, signs nothing):
import { requestSpendGrant, encodeSpendGrantRequest } from '@dexterai/vault/grant';

const blob = requestSpendGrant({
  app: { name: 'Acme Research', domain: 'acme.example' },
  counterparty: SELLER_ADDRESS,        // the on-chain binding (session PDA seed)
  capAtomic: '5000000',                // $5; the user may only SHORTEN
  expiresAtUnix: Math.floor(Date.now() / 1000) + 7 * 86400,
  sessionPubkey: AGENT_SESSION_PUBKEY, // optional; see custody note
});
const consentUrl = `https://dexter.cash/grant?req=${encodeSpendGrantRequest(blob)}`;

// Consent side: parse untrusted input, apply shorten-only edits, run the
// passkey ceremony over the exact bytes, end at the SIGNED GRANT:
import { parseSpendGrantRequest, approveSpendGrant } from '@dexterai/vault/grant';

const request = parseSpendGrantRequest(rawBlob);
const approved = await approveSpendGrant({
  request,
  vaultPda,                            // the USER's vault, never from the blob
  edits: { capAtomic: '2000000' },     // shorten-only; raises throw
  sign: (message) => myWebAuthnPipeline(message),
});
```

If the blob carries `sessionPubkey`, the requesting app's agent holds the session secret and can drive spend to the consented cap on its own pacing. Omit it and `approveSpendGrant` generates the keypair caller-side, so the requester never sees the secret. Either way exposure is bounded by cap × counterparty × expiry, enforced on-chain at settle.

---

## Byte-parity guarantee

`tests/byte-parity.test.ts`, `tests/precompile.test.ts`, `tests/swigBundle.test.ts`, `tests/counterfactual.test.ts`, and `tests/reader.test.ts` together snapshot:

- All **26 instruction discriminators**, derived from `sha256("global:<name>")` and checked against the pinned bytes.
- All **3 message layouts**, byte-by-byte: 188-byte V2 session registration, 128-byte revocation, 44-byte voucher payload.
- Both **precompile builders**, secp256r1 (SIMD-0075) and Ed25519, including the 14-byte offsets table.
- The **vault account decoder** for the V6 layout and the **162-byte SessionAccount decoder**.
- The **`buildSwigCreationBundle` structural lock**: ≥4 instructions, idempotent for the same `(identitySeed, hmacKey)`, the `settle_tab_voucher` Swig exec marker bytes matching the on-chain discriminator.
- The **counterfactual derivation** for a known seed.

If a future change drifts any of these by a single byte, the snapshot tests fail. The on-chain `dexter-vault` program is the ultimate referee; these tests catch the drift before it ships.

```bash
npm test
```

**Pre-audit, and we say so.** The `dexter-vault` program this package mirrors is not yet externally audited; funding is in flight. The report and any findings publish in the [program repo](https://github.com/Dexter-DAO/dexter-vault). Responsible disclosure: branch@dexter.cash.

## Architecture

```
                ┌─────────────────────────────────┐
                │  dexter-vault (Anchor program)  │  ← source of truth
                │  V6: 26 discriminators, 3 layouts│
                └────────────────┬────────────────┘
                                 │ defines bytes
                                 ▼
                ┌─────────────────────────────────┐
                │  @dexterai/vault (this package) │  ← off-chain mirror
                │  byte-parity locked by tests    │
                └────────┬────┬──────────┬────────┘
                         │    │          │
       ┌─────────────────┘    │          └──────────────────┐
       ▼                      ▼                             ▼
┌──────────────┐     ┌──────────────────┐         ┌───────────────────┐
│ dexter-api   │     │ dexter-facilitator│         │ dexter-vault tests│
│ (DB + glue)  │     │ (tab settle path) │         │ (anchor smokes)   │
└──────────────┘     └──────────────────┘         └───────────────────┘

        ▲                                                     ▲
        │                                                     │
        └────────── @dexterai/x402/tab imports message ───────┘
                    helpers from @dexterai/vault; keeps
                    the HTTP wrapping
```

---

## Subpath exports

Each subpath is a tree-shakeable entry point. Pull only what you need.

| Subpath | Contents |
|---|---|
| `@dexterai/vault` | Re-exports `types` + `counterfactual` + `session` for convenience |
| `@dexterai/vault/types` | `VaultState`, `VaultStateFull`, `SessionAccountState`, `SignedVoucher`, `VoucherPayload`, `AtomicAmount`, `HumanAmount`, `TabNetworkId`, and the rest |
| `@dexterai/vault/constants` | `DEXTER_VAULT_PROGRAM_ID`, `SWIG_PROGRAM_ID`, `USDC_MAINNET`/`USDC_DEVNET`, all 26 `DISCRIMINATORS`, `SESSION_SEED`, `LOCKED_CLAIM_SEED`, the OTS domain tags |
| `@dexterai/vault/instructions` | Every builder, including `buildSwigCreationBundle`, the session register/revoke pair, `buildSettleTabVoucherInstruction`, the withdrawal pair, `buildForceReleaseInstruction`, the rotate pair, `buildProvePasskeyInstruction`, the migrate pair |
| `@dexterai/vault/messages` | `sessionRegisterMessage` (188 bytes), `sessionRevokeMessage` (128 bytes), `buildVoucherMessage` (44 bytes), `buildSetSwigOperationMessage` |
| `@dexterai/vault/reader` | `readVaultOnchain` (slim), `readVaultFull` (adds `swigAddress`, `dexterAuthority`, `liveSessionCount`, `outstandingLockedAmount`), `decodeLockedClaim`, `fetchVaultLockedClaims` |
| `@dexterai/vault/session` | V6 per-counterparty sessions: `deriveSessionPda`, `fetchSessionAccount`, `fetchVaultSessionAccounts`, `sessionPdasOf`, `waitForSession`, `registerSessionWithRetry`, and the rest |
| `@dexterai/vault/grant` | Spend-grant consent flow: `requestSpendGrant`, `parseSpendGrantRequest`, `approveSpendGrant`, encode/decode |
| `@dexterai/vault/connect` | Relying-app "Connect a Tab" auth: `verifyConnectProof`, `connectTab`, `decodeChallengeTo32Bytes`, `ConnectProof`, `ConnectVerifyResult` |
| `@dexterai/vault/precompile` | `buildSecp256r1VerifyInstruction`, `buildPrecompileMessage`, `buildEd25519VerifyInstruction` |
| `@dexterai/vault/counterfactual` | `deriveCounterfactualAddresses` |
| `@dexterai/vault/signers` · `/node` · `/browser` | `Ed25519Signer` / `PasskeySigner` interfaces; `NodeEd25519Signer`; `WebAuthnAssertion` (browser P-256 ceremony) |
| `@dexterai/vault/tab` | Composed verbs: `openTab`, `settleTab`, `readTabMeter`, `drawCredit`, `repayCredit`, `seizeCollateral` |
| `@dexterai/vault/factoring` | `computeFactoringSplit`, `buildInstantPayoutInstructions` |
| `@dexterai/vault/kit` | `kitInstructionsToWeb3`, `getRpc` (Swig-kit↔web3 bridge) |

---

## Signer abstraction

```typescript
interface Ed25519Signer {
  readonly publicKey: Uint8Array;                              // 32 bytes
  sign(message: Uint8Array): Promise<Uint8Array>;              // 64-byte signature
}

interface PasskeySigner {
  readonly credentialId: Uint8Array;
  sign(challenge: Uint8Array): Promise<{
    signature: Uint8Array;
    clientDataJSON: Uint8Array;
    authenticatorData: Uint8Array;
  }>;
}
```

`NodeEd25519Signer` ships at `@dexterai/vault/signers/node`. The browser passkey signer is `WebAuthnAssertion` at `@dexterai/vault/signers/browser`: a pure-browser P-256 ceremony that runs `navigator.credentials.get()` and returns the three on-chain-ready buffers (64-byte compact lowS signature, raw `clientDataJSON`, raw `authenticatorData`), with zero `fetch` calls. It implements `PasskeySigner`; consumers compose it with their own server-policy adapter.

## Versioning

The current SDK targets the `dexter-vault` V6 program (26 pinned instructions; per-counterparty SessionAccount PDAs; role 3 `ProgramExec` for `settle_tab_voucher` on every new Swig). V5 vaults are not decodable by 0.10.x; migrate them with the `migrate_v5_to_v6` builders. The crystallized-claim reader (`outstandingLockedAmount`, `fetchVaultLockedClaims`, `decodeLockedClaim`) and the `settle_locked_voucher` Swig marker arrived in 0.10.0. Future program versions bump the SDK major or document the delta in the CHANGELOG. The byte-parity tests are the structural lock: any layout change requires an explicit snapshot update.

## License

MIT. © 2026 Dexter.

---

<p align="center">
  Part of the <a href="https://github.com/Dexter-DAO">Dexter-DAO</a> open source family.
</p>
