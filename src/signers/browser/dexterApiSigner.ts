import { WebAuthnAssertion } from './index.js';
import type { PasskeySignerWithPublicKey } from '../types.js';

// ── Auth-path server policy (credentialId-keyed) ──────────────────────────

export interface ServerPolicy {
  /**
   * dexter-api /api/passkey/sign/challenge — body `{ operationHash }`. The
   * operationHash (sha256 of the op message) becomes the WebAuthn challenge,
   * binding the assertion to the exact on-chain op (replay defense + the
   * on-chain webauthn.rs law: clientDataJSON.challenge === sha256(op)).
   * Mirrors dexter-fe/app/lib/passkey-signer.ts's auth leg. Returns the
   * server-issued challenge (=== operationHash).
   */
  issueChallenge(args: {
    credentialId: Uint8Array;
    operationHash: Uint8Array;
  }): Promise<Uint8Array>;
  /** dexter-api /sign/verify — verify the assertion (replay defense, sig counter). */
  verify(args: {
    credentialId: Uint8Array;
    signature: Uint8Array;
    clientDataJSON: Uint8Array;
    authenticatorData: Uint8Array;
  }): Promise<void>;
}

// ── Guest-path server policy (userHandle + operationHash keyed) ────────────
//
// The ANON / guest flow keys its challenge on a server-minted `userHandle`
// (16 bytes) plus the `operationHash` (sha256 of the operation message). The
// operationHash IS the WebAuthn challenge the server issues — that binding is
// the replay defense that ties the assertion to the exact on-chain operation
// being authorized. Mirrors dexter-fe/app/lib/passkey-signer.ts's guest leg
// and the POST /api/passkey-anon/sign/{challenge,verify} contract.

export interface AnonChallengeResult {
  /** The server-issued WebAuthn challenge to assert over. When an
   *  operationHash was supplied, the server uses it AS this challenge. */
  challenge: Uint8Array;
  /** The credential id the server resolved for this userHandle
   *  (from options.allowCredentials[0]). */
  credentialId: Uint8Array;
  rpId?: string;
  transports?: AuthenticatorTransport[];
}

export interface AnonServerPolicy {
  /**
   * dexter-api /api/passkey-anon/sign/challenge — body
   * `{ userHandle, operationHash }`. The operationHash (sha256 of the op
   * message) becomes the WebAuthn challenge, binding the assertion to the
   * on-chain op (replay defense). Returns the challenge + the server-resolved
   * allow-listed credential.
   */
  issueChallenge(args: {
    userHandle: Uint8Array;
    operationHash: Uint8Array;
  }): Promise<AnonChallengeResult>;
  /**
   * dexter-api /api/passkey-anon/sign/verify — body `{ credential, userHandle }`.
   * Replay-defense + credential↔userHandle binding + sig-counter check.
   */
  verify(args: {
    userHandle: Uint8Array;
    credentialId: Uint8Array;
    signature: Uint8Array;
    clientDataJSON: Uint8Array;
    authenticatorData: Uint8Array;
  }): Promise<void>;
}

// ── Identity discriminator (mirrors fe's kind: 'auth' | 'guest') ──────────

export type SignerIdentity =
  | { kind: 'auth' }
  | { kind: 'guest'; userHandle: Uint8Array };

interface AssertionLike {
  credentialId: Uint8Array;
  assertOver(challenge: Uint8Array): Promise<{
    signature: Uint8Array;
    clientDataJSON: Uint8Array;
    authenticatorData: Uint8Array;
  }>;
}

/**
 * Auth-path config (UNCHANGED public surface). Keyed on `credentialId` +
 * `ServerPolicy`. `identity` is optional and defaults to `{ kind: 'auth' }`
 * so every existing call site keeps working verbatim.
 */
export interface DexterApiSignerConfig {
  credentialId: Uint8Array;
  /**
   * The vault's stored authority pubkey: 33-byte SEC1 compressed P-256.
   * The consumer (fe / the x402 tab adapter) already knows this from the
   * vault account; the on-chain secp256r1 verifier compares against it on
   * every passkey-signed instruction. Exposed eagerly so the adapter can
   * build the precompile without a server round-trip.
   */
  publicKey: Uint8Array;
  identity?: { kind: 'auth' };
  policy: ServerPolicy;
  rpId?: string;
  /** Test seam: inject a fake WebAuthnAssertion. Production omits it. */
  __assertion?: AssertionLike;
}

/**
 * Guest-path config. Keyed on a server-minted `userHandle` + an
 * `AnonServerPolicy`. No `credentialId` up front — the server resolves it
 * from the userHandle and returns it in the challenge response (exactly like
 * fe's reference, where credentialId comes from options.allowCredentials).
 */
export interface DexterApiGuestSignerConfig {
  identity: { kind: 'guest'; userHandle: Uint8Array };
  /** 33-byte SEC1 compressed P-256 authority pubkey (vault-stored). */
  publicKey: Uint8Array;
  anonPolicy: AnonServerPolicy;
  rpId?: string;
  /** Test seam: inject a fake WebAuthnAssertion. Production omits it. */
  __assertion?: AssertionLike;
}

export type DexterApiBrowserPasskeySignerConfig =
  | DexterApiSignerConfig
  | DexterApiGuestSignerConfig;

function isGuestConfig(
  config: DexterApiBrowserPasskeySignerConfig,
): config is DexterApiGuestSignerConfig {
  return (config as DexterApiGuestSignerConfig).identity?.kind === 'guest';
}

/**
 * Canonical browser passkey signer: the raw WebAuthnAssertion ceremony + the
 * dexter-api server policy (challenge/verify) packaged so consumers (fe,
 * dexter-agents, the x402 tab adapter, the connector) don't each re-roll it.
 * Conforms to PasskeySigner; outputs Uint8Array (not base64) so the x402
 * adapter can drop its stub and import this type. "Unify, don't bridge."
 *
 * Two keyings, one class — mirroring dexter-fe's `kind: 'auth' | 'guest'`:
 *
 * ONE canonical method — `signOperation(operationMessage)` — both keyings honor:
 *
 *   - **auth**  — logged-in flow, keyed on `credentialId` + `ServerPolicy`.
 *     Mints a challenge bound to sha256(op) (the on-chain webauthn.rs law +
 *     replay defense), asserts over it, verifies with `{ credentialId }`.
 *
 *   - **guest** — no-account ANON flow, keyed on a server-minted `userHandle`
 *     + `AnonServerPolicy`. Authorizes tab-opens/spends for a guest who signs
 *     in through the connector. Mints a challenge bound to sha256(op), asserts
 *     over the server challenge, verifies with `{credential, userHandle}`.
 *
 * No throwing stub: a consumer can never be handed a method that throws.
 */
export class DexterApiBrowserPasskeySigner implements PasskeySignerWithPublicKey {
  /**
   * For the auth path this is the configured credentialId. For the guest path
   * the credentialId is resolved server-side from the userHandle; it starts
   * empty and is populated after the first `signOperation()`.
   */
  credentialId: Uint8Array;
  /** 33-byte SEC1 compressed P-256 authority pubkey (vault-stored). */
  readonly publicKey: Uint8Array;
  readonly identity: SignerIdentity;
  private readonly policy?: ServerPolicy;
  private readonly anonPolicy?: AnonServerPolicy;
  private readonly rpId?: string;
  private readonly injectedAssertion?: AssertionLike;

  constructor(config: DexterApiBrowserPasskeySignerConfig) {
    this.publicKey = config.publicKey;
    this.rpId = config.rpId;
    this.injectedAssertion = config.__assertion;

    if (isGuestConfig(config)) {
      this.identity = { kind: 'guest', userHandle: config.identity.userHandle };
      this.anonPolicy = config.anonPolicy;
      // Resolved from the server on first signOperation().
      this.credentialId = new Uint8Array(0);
    } else {
      this.identity = { kind: 'auth' };
      this.credentialId = config.credentialId;
      this.policy = config.policy;
    }
  }

  // ── Canonical method (ONE method, both keyings) ───────────────────────────

  /**
   * Sign a RAW on-chain OPERATION MESSAGE. The ONE honest method both auth and
   * guest honor — no throwing stub. Mirrors dexter-fe AND the on-chain
   * webauthn.rs law:
   *
   *   1. opHash = sha256(operationMessage)
   *   2. mint a server challenge bound to opHash (auth: keyed on credentialId;
   *      guest: keyed on userHandle). The opHash IS the WebAuthn challenge —
   *      binds the assertion to this exact on-chain op (replay defense).
   *   3. run the WebAuthn assertion over the SERVER-issued challenge.
   *   4. verify with the server (replay-defense + sig counter).
   *
   * Invariant (money-path): clientDataJSON.challenge === sha256(operationMessage),
   * exactly what programs/dexter-vault/src/verify/webauthn.rs requires.
   *
   * Returns the three on-chain-ready Uint8Array fields (compact lowS signature,
   * raw clientDataJSON, raw authenticatorData). The 64-byte `signature` is what
   * the SIMD-0075 precompile expects.
   */
  async signOperation(operationMessage: Uint8Array): Promise<{
    signature: Uint8Array;
    clientDataJSON: Uint8Array;
    authenticatorData: Uint8Array;
  }> {
    const operationHash = await sha256(operationMessage);

    let challenge: Uint8Array;
    let credentialId: Uint8Array;
    let rpId: string | undefined;
    let transports: AuthenticatorTransport[] | undefined;

    if (this.identity.kind === 'guest') {
      if (!this.anonPolicy) throw new Error('guest signer missing anonPolicy');
      const { userHandle } = this.identity;
      // Mint bound to userHandle + opHash; server resolves the credential.
      const minted = await this.anonPolicy.issueChallenge({ userHandle, operationHash });
      challenge = minted.challenge;
      credentialId = minted.credentialId;
      rpId = minted.rpId;
      transports = minted.transports;
      // Surface the server-resolved credentialId.
      this.credentialId = minted.credentialId;
    } else {
      if (!this.policy) throw new Error('auth signer missing policy');
      credentialId = this.credentialId;
      // Mint bound to credentialId + opHash; server uses opHash AS the challenge.
      challenge = await this.policy.issueChallenge({ credentialId, operationHash });
    }

    // Run the WebAuthn ceremony over the SERVER-issued challenge.
    const assertion = this.assertionFor(credentialId, rpId, transports);
    const res = await assertion.assertOver(challenge);

    // Verify with the server (replay defense, sig counter).
    if (this.identity.kind === 'guest') {
      await this.anonPolicy!.verify({
        userHandle: this.identity.userHandle,
        credentialId,
        signature: res.signature,
        clientDataJSON: res.clientDataJSON,
        authenticatorData: res.authenticatorData,
      });
    } else {
      await this.policy!.verify({
        credentialId,
        signature: res.signature,
        clientDataJSON: res.clientDataJSON,
        authenticatorData: res.authenticatorData,
      });
    }

    return {
      signature: res.signature,
      clientDataJSON: res.clientDataJSON,
      authenticatorData: res.authenticatorData,
    };
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private assertionFor(
    credentialId: Uint8Array,
    rpId?: string,
    transports?: AuthenticatorTransport[],
  ): AssertionLike {
    if (this.injectedAssertion) return this.injectedAssertion;
    return new WebAuthnAssertion({
      credentialId,
      rpId: rpId ?? this.rpId,
      ...(transports ? { allowCredentials: [{ id: credentialId, transports }] } : {}),
    });
  }
}

async function sha256(buf: Uint8Array): Promise<Uint8Array> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (!subtle) {
    throw new Error(
      'DexterApiBrowserPasskeySigner.signOperation requires a Web Crypto environment (globalThis.crypto.subtle)',
    );
  }
  const out = await subtle.digest('SHA-256', new Uint8Array(buf));
  return new Uint8Array(out);
}
