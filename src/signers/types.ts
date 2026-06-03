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
