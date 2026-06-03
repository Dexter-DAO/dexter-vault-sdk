/**
 * Node Ed25519 signer — wraps a secret-key seed with tweetnacl.
 *
 * Used by dexter-api as its dexter-authority signer (the server-held
 * session master) and by dexter-vault tests as a deterministic stand-in.
 */

import nacl from 'tweetnacl';
import type { Ed25519Signer } from '../types.js';

export class NodeEd25519Signer implements Ed25519Signer {
  private readonly keypair: nacl.SignKeyPair;

  /**
   * @param secretKey 32-byte seed OR 64-byte nacl secret-key buffer
   *                  (seed || pubkey). Both shapes are accepted.
   */
  constructor(secretKey: Uint8Array) {
    if (secretKey.length === 32) {
      this.keypair = nacl.sign.keyPair.fromSeed(secretKey);
    } else if (secretKey.length === 64) {
      this.keypair = nacl.sign.keyPair.fromSecretKey(secretKey);
    } else {
      throw new Error(`NodeEd25519Signer: secretKey must be 32 or 64 bytes, got ${secretKey.length}`);
    }
  }

  get publicKey(): Uint8Array {
    return this.keypair.publicKey;
  }

  async sign(message: Uint8Array): Promise<Uint8Array> {
    return nacl.sign.detached(message, this.keypair.secretKey);
  }
}
