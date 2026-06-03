/**
 * Per-vault-operation message helpers.
 *
 * These are what the user's passkey signs for instructions that the
 * on-chain handler verifies via the secp256r1 precompile sibling.
 */

import { PublicKey } from '@solana/web3.js';

/**
 * Message format for the `set_swig` instruction:
 *
 *   bytes("set_swig") || swigStatePda (32 bytes)
 */
export function buildSetSwigOperationMessage(swigStatePda: string): Uint8Array {
  const prefix = Buffer.from('set_swig', 'utf8');
  const addressBytes = new PublicKey(swigStatePda).toBytes();
  const out = new Uint8Array(prefix.length + addressBytes.length);
  out.set(prefix, 0);
  out.set(addressBytes, prefix.length);
  return out;
}
