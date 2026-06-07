# Connect a Tab

"Connect a Tab" lets a user prove, at your app, that they control their Dexter tab (vault). It is the auth half of agent payments: the "Connect Wallet" analogue for spending. One button.

This doc covers **step 1: auth**, the proof of control. The **spend grant** (letting the user's agent actually pay your app, up to a bound they set) is a separate, deliberate second step. It is spec'd and shipping next; see [What's next](#whats-next). Auth does not grant spending.

## Install

```bash
npm i @dexterai/vault
```

```ts
import { connectTab, verifyConnectProof } from '@dexterai/vault/connect';
```

## The flow

Three actors: your **server** issues a challenge, your **client** runs the passkey ceremony, your **server** verifies the result. No fees, no on-chain state change: the verifier only simulates a read-only proof.

### (a) Server issues a challenge

Generate 32 random bytes per attempt and encode them as unpadded base64url. Store the string against the session so a returned proof can only satisfy the challenge you handed out (replay defense).

```ts
import crypto from 'node:crypto';

function issueChallenge() {
  // 32 random bytes → unpadded base64url. This is the canonical issuer form.
  const challenge = crypto.randomBytes(32).toString('base64url');
  // Persist `challenge` against the session; you compare against it in step (c).
  return challenge;
}
```

The challenge contract: `verifyConnectProof` maps your challenge string to the 32 on-chain bytes itself. If the string base64url-decodes to exactly 32 bytes, those bytes are the challenge; otherwise it falls back to `sha256(utf8(challenge))`. You do not compute any hash. Issue a random `base64url(32 bytes)` string and pass that same string to both the client and the verifier. The base64url form is the canonical, zero-ambiguity choice.

### (b) Client runs the ceremony

`connectTab` runs the WebAuthn passkey assertion in the browser and returns a `ConnectProof`.

```ts
import { connectTab } from '@dexterai/vault/connect';

const proof = await connectTab({
  challenge,        // the string from step (a)
  vault,            // base58 vault PDA the user is connecting
  passkeyPubkey,    // 33-byte compressed P-256 pubkey bound to the vault (Uint8Array)
  credentialId,     // raw WebAuthn credential ID bytes for the vault's passkey (Uint8Array)
  rpId,             // optional WebAuthn RP id; defaults to the page's RP
});
// proof: { passkeyPubkey, vault, clientDataJSON, authenticatorData, signature }
```

Where `vault`, `passkeyPubkey`, and `credentialId` come from: the user's Dexter tab. The user selects or supplies the tab, or your app looked it up ahead of time. Resolving **which** vault is your app's job. `connectTab` proves control of a vault you name; it does not discover one.

`ConnectProof` shape (the exact object you post to your server):

```ts
interface ConnectProof {
  passkeyPubkey: Uint8Array;     // 33-byte compressed P-256 pubkey
  vault: string;                 // base58 vault PDA the proof claims
  clientDataJSON: Uint8Array;    // WebAuthn ceremony output
  authenticatorData: Uint8Array; // WebAuthn ceremony output
  signature: Uint8Array;         // 64-byte compact lowS r||s P-256 signature
}
```

### (c) Server verifies

`verifyConnectProof` rebuilds the read-only `[secp256r1_verify, prove_passkey]` proof transaction and simulates it against your RPC. `result.ok === true` means the holder controls `result.vault`.

```ts
import { Connection } from '@solana/web3.js';
import { verifyConnectProof } from '@dexterai/vault/connect';

// Your Helius mainnet RPC. Never api.mainnet-beta.solana.com, which does not
// expose the P-256 precompile path the proof simulates.
const connection = new Connection(process.env.HELIUS_RPC_URL!);

const result = await verifyConnectProof({
  connection,
  challenge,  // the SAME string you issued in step (a)
  proof,      // the ConnectProof posted from the client
});

if (result.ok) {
  // result.vault is a PublicKey. The user controls it; bind it to the session.
  session.vault = result.vault.toBase58();
} else {
  // result.reason carries the rejection detail.
  throw new Error(`connect failed: ${result.reason}`);
}
```

`ConnectVerifyResult` is `{ ok: boolean; vault?: PublicKey; reason?: string }`. The check is simulate-driven: a forged proof, a wrong passkey, or a mismatched challenge makes the on-chain precompile (or the `prove_passkey` op-message check) reject, and simulate returns a non-null error. The reject path runs through simulation, so a string compare cannot bypass it. The simulation reads only, with no fee and no state change. It needs a mainnet RPC (Helius).

## The button

A minimal "Connect a Tab" button: on click it runs `connectTab` and posts the proof to your verify endpoint. Framework-neutral.

```html
<button id="connect-tab">
  Connect a Tab
  <span>and your agent can pay here, up to a limit you set.</span>
</button>
```

```ts
import { connectTab } from '@dexterai/vault/connect';

document.getElementById('connect-tab')!.addEventListener('click', async () => {
  // challenge: fetch from your server (step a). vault/passkeyPubkey/credentialId:
  // resolved from the user's selected Dexter tab.
  const { challenge } = await fetch('/api/connect/challenge').then((r) => r.json());

  const proof = await connectTab({ challenge, vault, passkeyPubkey, credentialId });

  const result = await fetch('/api/connect/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      proof: {
        passkeyPubkey: Array.from(proof.passkeyPubkey),
        vault: proof.vault,
        clientDataJSON: Array.from(proof.clientDataJSON),
        authenticatorData: Array.from(proof.authenticatorData),
        signature: Array.from(proof.signature),
      },
    }),
  }).then((r) => r.json());

  // result.ok → the user controls result.vault. Rehydrate Uint8Arrays on the
  // server before calling verifyConnectProof.
});
```

The button copy is fixed:

- Label: **Connect a Tab**
- Sub-copy: **and your agent can pay here, up to a limit you set.**

The sub-copy names the spend capability so the user knows what connecting leads to. It does not authorize spending. That is the second click.

## The two consents

Auth (this) and the spend grant (next) are two separate clicks, two separate consents. They are never fused.

Connecting a tab proves who the user is. It does not let your app move their money. Folding "prove who you are" into "let this app spend my funds" is a dark pattern, and Connect a Tab keeps them apart on purpose. The button names the spend capability honestly so the user understands where this leads, but the **spend authorization is a deliberate second step** the user takes separately.

## What's next

The spend grant is the second step: a bounded session-key registration scoped to your app. The user sets the bound; the agent can pay your app within it. It is spec'd and shipping next. When it lands, this doc gains a step 2 and your app can collect payments from a connected tab within the user-set limit.
