import { WebAuthnAssertion } from './index.js';
import type { PasskeySigner } from '../types.js';

export interface ServerPolicy {
  /** dexter-api /sign/challenge — issue a 32-byte challenge for this credential. */
  issueChallenge(args: { credentialId: Uint8Array }): Promise<Uint8Array>;
  /** dexter-api /sign/verify — verify the assertion (replay defense, sig counter). */
  verify(args: {
    credentialId: Uint8Array;
    signature: Uint8Array;
    clientDataJSON: Uint8Array;
    authenticatorData: Uint8Array;
  }): Promise<void>;
}

interface AssertionLike {
  credentialId: Uint8Array;
  assertOver(challenge: Uint8Array): Promise<{
    signature: Uint8Array;
    clientDataJSON: Uint8Array;
    authenticatorData: Uint8Array;
  }>;
}

export interface DexterApiSignerConfig {
  credentialId: Uint8Array;
  policy: ServerPolicy;
  rpId?: string;
  /** Test seam: inject a fake WebAuthnAssertion. Production omits it. */
  __assertion?: AssertionLike;
}

/**
 * Canonical browser passkey signer: the raw WebAuthnAssertion ceremony + the
 * dexter-api server policy (challenge/verify) packaged so consumers (fe,
 * dexter-agents, the x402 tab adapter) don't each re-roll it. Conforms to
 * PasskeySigner; outputs Uint8Array (not base64) so the x402 adapter can drop
 * its stub and import this type. "Unify, don't bridge."
 */
export class DexterApiBrowserPasskeySigner implements PasskeySigner {
  readonly credentialId: Uint8Array;
  private readonly policy: ServerPolicy;
  private readonly assertion: AssertionLike;

  constructor(config: DexterApiSignerConfig) {
    this.credentialId = config.credentialId;
    this.policy = config.policy;
    this.assertion =
      config.__assertion ?? new WebAuthnAssertion({ credentialId: config.credentialId, rpId: config.rpId });
  }

  /** Sign a caller-supplied challenge, then run the server verify leg. */
  async sign(challenge: Uint8Array): Promise<{
    signature: Uint8Array;
    clientDataJSON: Uint8Array;
    authenticatorData: Uint8Array;
  }> {
    const res = await this.assertion.assertOver(challenge);
    await this.policy.verify({
      credentialId: this.credentialId,
      signature: res.signature,
      clientDataJSON: res.clientDataJSON,
      authenticatorData: res.authenticatorData,
    });
    return { signature: res.signature, clientDataJSON: res.clientDataJSON, authenticatorData: res.authenticatorData };
  }

  /** Convenience: fetch a server challenge, then sign it. */
  async signWithServerChallenge(): Promise<{
    signature: Uint8Array;
    clientDataJSON: Uint8Array;
    authenticatorData: Uint8Array;
  }> {
    const challenge = await this.policy.issueChallenge({ credentialId: this.credentialId });
    return this.sign(challenge);
  }
}
