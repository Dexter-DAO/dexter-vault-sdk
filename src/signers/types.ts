/**
 * Signer abstractions.
 *
 * Ed25519Signer is shipped with a Node implementation in v0.1.
 * PasskeySigner is shipped as INTERFACE ONLY in v0.1 — the WebAuthn
 * implementation is tracked as task #235 ("@dexterai/vault v0.2 —
 * BrowserPasskeySigner") and must lift from dexter-fe/app/lib/passkey.ts +
 * dexter-fe/app/lib/passkey-anon.ts. Until v0.2 ships, dexter-fe stays on
 * its hand-rolled passkey ceremony.
 */

export interface Ed25519Signer {
  /** 32-byte public key. */
  readonly publicKey: Uint8Array;
  /** Produce a 64-byte detached signature over `message`. */
  sign(message: Uint8Array): Promise<Uint8Array>;
}

export interface PasskeySigner {
  /** Opaque credential ID handed back to the platform authenticator. */
  readonly credentialId: Uint8Array;
  /**
   * Run the WebAuthn assertion ceremony over `challenge` and return the
   * three things the precompile needs.
   *
   * Implementation: TASK #235. dexter-fe currently ships an equivalent
   * function in app/lib/passkey.ts (`signOperation`) — the lift target.
   */
  sign(challenge: Uint8Array): Promise<{
    signature: Uint8Array;
    clientDataJSON: Uint8Array;
    authenticatorData: Uint8Array;
  }>;
}

/**
 * The honest, policy-wrapped passkey signer surface.
 *
 * ONE canonical method — `signOperation(operationMessage)` — that BOTH the
 * auth (logged-in) and guest (ANON) keyings honor. It takes the RAW on-chain
 * operation message, hashes it internally (opHash = sha256(op)), mints a
 * server challenge bound to that hash, runs the WebAuthn assertion over the
 * server challenge, and returns the three on-chain-ready byte fields.
 *
 * Invariant (the on-chain webauthn.rs law):
 *   clientDataJSON.challenge === sha256(operationMessage)
 *
 * This is distinct from the low-level `PasskeySigner.sign(challenge)` ceremony
 * driver (WebAuthnAssertion), which asserts over a raw challenge with no
 * hashing/policy. A consumer handed a `PasskeySignerWithPublicKey` can never
 * be handed a method that throws — both auth and guest implement
 * `signOperation` honestly.
 *
 * Also exposes the 33-byte SEC1 compressed P-256 public key eagerly: the x402
 * tab adapter reads `publicKey` for the secp256r1 precompile.
 */
export interface PasskeySignerWithPublicKey {
  /** Opaque credential ID. For guest signers, resolved after first signOperation(). */
  readonly credentialId: Uint8Array;
  /** 33-byte SEC1 compressed P-256 public key (the form the vault stores). */
  readonly publicKey: Uint8Array;
  /**
   * Sign a RAW on-chain operation message. Hashes internally and binds
   * sha256(op) as the WebAuthn challenge. Honored by BOTH auth and guest.
   */
  signOperation(operationMessage: Uint8Array): Promise<{
    signature: Uint8Array;
    clientDataJSON: Uint8Array;
    authenticatorData: Uint8Array;
  }>;
}
