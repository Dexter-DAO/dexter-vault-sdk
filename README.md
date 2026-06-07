<p align="center">
  <img src="https://raw.githubusercontent.com/Dexter-DAO/dexter-vault-sdk/main/assets/dexter-wordmark.svg" alt="Dexter" width="360">
</p>

<h1 align="center">@dexterai/vault</h1>

<p align="center">
  <strong>The off-chain mirror of the dexter-vault Anchor program. Byte-precise instruction builders, message encoders, account decoders, and signer abstractions for the unruggable passkey vault.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@dexterai/vault"><img src="https://img.shields.io/npm/v/@dexterai/vault.svg" alt="npm"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E=18-brightgreen.svg" alt="Node"></a>
  <a href="https://github.com/Dexter-DAO/dexter-vault-sdk"><img src="https://img.shields.io/badge/program-Hg3wRayd…2fhc-blueviolet" alt="Vault program"></a>
  <a href="https://solscan.io/tx/4VLDNUDtY8Q3ucwFyuCEz7BsBFqYzUo2ANQv4KU2TDnrUEcn9tS7KmyqHGkZjM6AqEf9uZuS1W5CTQ1RKL47QU89"><img src="https://img.shields.io/badge/first_settle-on_mainnet-success" alt="First mainnet settle"></a>
</p>

<p align="center">
  <a href="https://dexter.cash"><strong>See it on dexter.cash →</strong></a>
</p>

---

<!-- GTM-DRAFT: product framing/wording pending GTM agent review before publish -->

## Open a tab for your agent

You open a tab with a hard limit. Your agent spends against it, charge by charge, with no signature prompt per charge. When the work is done you settle and the tab closes. The spending limit is enforced by the Solana program at consensus, not by this SDK and not by Dexter. The SDK never holds a key that can overspend it, and you can verify the cap on-chain yourself.

```ts
import { openTab, settleTab, readTabMeter } from '@dexterai/vault/tab';

// arm a tab with a chain-enforced cap
const open = await openTab({ vaultPda, amount: 5_000_000n, dexterAuthority });

// settle a streamed micro-charge (composes precompile + settle + transfer)
const settle = await settleTab({
  connection, vaultPda, swigAddress, channelId,
  cumulativeAmount, sequenceNumber, sessionSigner, sellerAta, feePayer, dexterAuthority,
});

// read remaining headroom (the chain is the real guard)
const meter = await readTabMeter(connection, vaultPda);
```

That is the whole product loop: `openTab` arms a capped tab, `settleTab` records each streamed charge against it, `readTabMeter` reports the headroom left. The buyer's USDC never leaves their wallet while the tab runs; the program gates their exit until the tab settles. The closest familiar shape is an auth-and-capture credit-card hold, except the hold is enforced on-chain instead of by a processor.

A tab can also spend **past** the user's balance, backed by a financier's standby capital: non-custodial, and structured so the buyer cannot rug the financier and the financier cannot seize more than the agreed bound. Every guard in that path is proven on Solana mainnet, including a real draw, a real repayment, a real default-and-seize, and every anti-rug rejection. Same import, three more verbs:

```ts
import { drawCredit, repayCredit, seizeCollateral } from '@dexterai/vault/tab';
```

Credit is not a separate product bolted onto a tab. It is a tab that can spend past its balance. That is why it lives in the same import.

> **Two sides.** This package is the buyer side. The seller side (verify vouchers, meter consumption, accept payment in about ten lines) lives in `@dexterai/x402`. Together they cover both halves of agent payments on Solana.

Every `./tab` verb returns `TransactionInstruction[]`, so you own signing, fees, and sending.

---

## Under the hood: the primitives

If the four `./tab` verbs are all you need, you can stop reading here. The rest of this package is the low-level surface those verbs are built from, exposed for the servers that assemble their own transactions.

The `dexter-vault` Solana program is a non-custodial passkey-rooted vault: WebAuthn signs every spend, a programmatic Swig role makes the unruggable streaming channel possible, and the entire spend path goes through the vault program, with no master key, no escrow, and no trust.

This package is the TypeScript that talks to it. Every byte the on-chain program checks lives here, in exactly one file each: instruction discriminators, the 188-byte V2 session-registration message, the 128-byte revocation message, the 44-byte voucher payload, and the vault account layout. Three repos used to hand-roll these primitives and one of them missed a role; that bug is now structurally impossible.

The `./tab` verbs above compose these primitives. The tiers stack on top of the same building blocks: the streaming tab (`settle_tab_voucher`), the credit tab (`draw_credit` / `repay_credit` / `seize_collateral`), the LockedClaim crystallized tier (`@dexterai/vault/instructions`), and factoring / instant payout (`@dexterai/vault/factoring`).

If you are about to hand-roll a vault instruction builder, a precompile message, a Swig role list, or a vault account decoder, **stop and import from here instead**.

---

## Install

```bash
npm install @dexterai/vault
```

Targets the `dexter-vault` V5 program (21 Anchor discriminators including `prove_passkey`, `settle_tab_voucher`, the session-key register/revoke pair, the LockedClaim set, and the credit set `open_standby` / `draw_credit` / `repay_credit` / `seize_collateral`).

---

## Quick start

### Build the canonical 4-role Swig (server-side enrollment)

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

// `bundle.instructions` is the atomic create+grant×3 sequence.
// `bundle.swigAddress` is the deterministic Swig PDA for this user.
const tx = new Transaction().add(...bundle.instructions);
```

The 4-role design (role 0 bootstrap, role 1 `ProgramExec(finalize_withdrawal)`, role 2 session master, role 3 `ProgramExec(settle_tab_voucher)`) lives in exactly one function. Tests in this repo lock the role list against the on-chain Anchor discriminators.

### Settle a Tab voucher on chain (facilitator-side)

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
  buildSettleTabVoucherInstruction({
    vaultPda,
    swigAddress: new PublicKey(vaultState.swigAddress!),
    dexterAuthority: sessionMaster.publicKey,
    channelId,
    cumulativeAmount,
    sequenceNumber,
  }),
);
```

The first mainnet settle: [`4VLDNUDt…RKL47QU89`](https://solscan.io/tx/4VLDNUDtY8Q3ucwFyuCEz7BsBFqYzUo2ANQv4KU2TDnrUEcn9tS7KmyqHGkZjM6AqEf9uZuS1W5CTQ1RKL47QU89).

### Read live vault state

```typescript
import { readVaultOnchain, readVaultFull } from '@dexterai/vault/reader';

// Slim shape: { exists, pendingVoucherCount, pendingWithdrawal }.
const slim = await readVaultOnchain(connection, vaultPda);

// Full shape adds: { version, swigAddress, dexterAuthority, activeSession }.
const full = await readVaultFull(connection, vaultPda);
if (full.activeSession) {
  console.log(`tab open: ${full.activeSession.spent} / ${full.activeSession.maxAmount}`);
}
```

### Derive the counterfactual Swig address

```typescript
import { deriveCounterfactualAddresses } from '@dexterai/vault/counterfactual';

// Returns both the state PDA (program-owned) and the wallet-address PDA
// (system-owned, the asset holder). Useful for showing users a deposit
// address before the Swig is on chain.
const { swigStateAddress, swigWalletAddress } = await deriveCounterfactualAddresses({
  identitySeed: userHandleBytes,
  hmacKey: serverSecret.subarray(0, 32),
});
```

### Sign with an Ed25519 signer (server)

```typescript
import { NodeEd25519Signer } from '@dexterai/vault/signers/node';

const signer = new NodeEd25519Signer(secretKey);   // 32-byte seed OR 64-byte secret key
const sig = await signer.sign(messageBytes);       // 64-byte detached signature
```

---

## Subpath exports

Each subpath is a tree-shakeable entry point. Pull only what you need.

| Subpath | Contents |
|---|---|
| `@dexterai/vault` | Re-exports `types` + `counterfactual` for convenience |
| `@dexterai/vault/types` | `VaultState`, `VaultStateFull`, `ActiveSession`, `PendingWithdrawal`, `SessionKey`, `SessionScope`, `SignedVoucher`, `VoucherPayload`, `AtomicAmount`, `HumanAmount`, `TabNetworkId` |
| `@dexterai/vault/constants` | `DEXTER_VAULT_PROGRAM_ID`, `SWIG_PROGRAM_ID`, `USDC_MAINNET`/`USDC_DEVNET`, all 21 `DISCRIMINATORS`, `LOCKED_CLAIM_SEED`, `OTS_SESSION_REGISTER_V1_DOMAIN`, `OTS_SESSION_REGISTER_V2_DOMAIN`, `OTS_SESSION_REVOKE_V1_DOMAIN` |
| `@dexterai/vault/instructions` | Every builder: `buildInitializeVaultInstruction`, `buildSetSwigInstruction`, `buildRegisterSessionKeyInstruction`, `buildRevokeSessionKeyInstruction`, `buildSettleVoucherInstruction`, `buildSettleTabVoucherInstruction`, `buildRequestWithdrawalInstruction`, `buildFinalizeWithdrawalInstruction`, `buildForceReleaseInstruction`, `buildRotatePasskeyInstruction`, `buildRotateDexterAuthorityInstruction`, `buildProvePasskeyInstruction`, and the canonical `buildSwigCreationBundle` + `expectedSwigAddressFor` + `verifySwigIsOurs` |
| `@dexterai/vault/messages` | `sessionRegisterMessage` (188 bytes, V2), `sessionRevokeMessage` (128 bytes), `voucherPayloadMessage` / `buildVoucherMessage` (44 bytes), `buildSetSwigOperationMessage` |
| `@dexterai/vault/reader` | `readVaultOnchain` (slim), `readVaultFull` (with active session) |
| `@dexterai/vault/precompile` | `buildSecp256r1VerifyInstruction`, `buildPrecompileMessage`, `buildEd25519VerifyInstruction` |
| `@dexterai/vault/counterfactual` | `deriveCounterfactualAddresses` |
| `@dexterai/vault/signers` | `Ed25519Signer`, `PasskeySigner` interfaces |
| `@dexterai/vault/signers/node` | `NodeEd25519Signer` (tweetnacl-backed) |
| `@dexterai/vault/signers/browser` | `WebAuthnAssertion` (pure-browser P-256 passkey ceremony, shipped 0.2.0), `derSignatureToCompactLowS` |
| `@dexterai/vault/tab` | Product layer: `openTab`, `settleTab`, `readTabMeter`, `drawCredit`, `repayCredit`, `seizeCollateral`, `defaultAssembleSignV2` |
| `@dexterai/vault/factoring` | `computeFactoringSplit`, `buildInstantPayoutInstructions` (settle a LockedClaim and split the payout) |
| `@dexterai/vault/kit` | `kitInstructionsToWeb3`, `getRpc` (Swig-kit↔web3 bridge) |

---

## Why this package exists

Three places used to hand-roll the same protocol: `dexter-api/src/vault/`, `dexter-facilitator/src/vault/`, and `dexter-vault/tests/`. One of them added role 3 (`ProgramExec` for `settle_tab_voucher`); two didn't. The end-to-end Tab settle smoke kept failing with `Role not found for ID: 3` and it ate hours of debugging on 2026-06-02 before anyone noticed the drift.

This package is the structural fix. The canonical 4-role Swig provisioner, every instruction builder, every byte-precise message encoder, the vault account decoder, and the precompile helpers each live in exactly one file. Consumers (`dexter-api`, `dexter-facilitator`, `dexter-vault` tests, `@dexterai/x402/tab`) import from here. The drift bug class is gone.

---

## Byte-parity guarantee

`tests/byte-parity.test.ts`, `tests/precompile.test.ts`, `tests/swigBundle.test.ts`, `tests/counterfactual.test.ts`, and `tests/reader.test.ts` together snapshot:

- All **21 instruction discriminators**, derived from `sha256("global:<name>")` and checked against the pinned bytes, covering the vault core, the session-key pair, the LockedClaim set, and the credit set.
- All **3 message layouts**, byte-by-byte: 188-byte V2 session registration, 128-byte revocation, 44-byte voucher payload.
- Both **precompile builders**, secp256r1 (SIMD-0075) and Ed25519, including the 14-byte offsets table.
- The **vault account decoder** for every V5 layout combination (with/without pending withdrawal, with/without active session).
- The **`buildSwigCreationBundle` structural lock**: ≥4 instructions, idempotent for the same `(identitySeed, hmacKey)`, distinct outputs for different inputs, the `settle_tab_voucher` Swig exec marker bytes match the on-chain discriminator.
- The **counterfactual derivation** for a known seed.

If a future change drifts any of these by a single byte, the snapshot tests fail. The on-chain `dexter-vault` program is the ultimate referee, but these tests are the gate that catches the drift before it ships.

```bash
npm test
```

---

## Architecture

```
                ┌─────────────────────────────────┐
                │  dexter-vault (Anchor program)  │  ← source of truth
                │  V5: 21 discriminators, 3 layouts│
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
│ (DB + glue)  │     │ (Tab settle path) │         │ (anchor smokes)   │
└──────────────┘     └──────────────────┘         └───────────────────┘
                                                              
        ▲                                                     ▲
        │                                                     │
        └────────── @dexterai/x402/tab imports message ───────┘
                    helpers from @dexterai/vault; keeps
                    HTTP/SSE wrapping
```

---

## Signer abstraction

The package defines two interfaces in `@dexterai/vault/signers`:

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

`NodeEd25519Signer` ships at `@dexterai/vault/signers/node`. The browser passkey signer shipped in 0.2.0 as `WebAuthnAssertion` at `@dexterai/vault/signers/browser`: a pure-browser P-256 ceremony that runs `navigator.credentials.get()` and returns the three on-chain-ready buffers (64-byte compact lowS signature, raw `clientDataJSON`, raw `authenticatorData`), zero `fetch` calls. It implements the `PasskeySigner` interface; consumers compose it with their own server-policy adapter. This unlocks browser-buyer flows on dexter.cash and anywhere else a user pays through their passkey vault.

---

## Versioning

The current SDK targets the `dexter-vault` V5 program (21 Anchor instructions; role 3 `ProgramExec` for `settle_tab_voucher` registered on every new Swig).

Future program versions will bump the SDK major or document the delta in the CHANGELOG. The byte-parity tests are the structural lock: any layout change requires an explicit snapshot update.

---

## License

MIT. © 2026 Dexter.

---

<p align="center">
  Part of the <a href="https://github.com/Dexter-DAO">Dexter-DAO</a> open source family.
</p>
