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

/**
 * Message format for the USER leg of `open_standby` (what the user's passkey
 * signs; the on-chain handler verifies it via the secp256r1 precompile sibling):
 *
 *   bytes("open_standby") (12) || vaultPda (32) || financierSwig (32) || cap u64 LE (8) = 84 bytes
 *
 * MUST match open_standby.rs::op_msg byte-for-byte.
 */
export function buildOpenStandbyMessage(
  vaultPda: PublicKey,
  financierSwig: PublicKey,
  cap: bigint,
): Uint8Array {
  const tag = Buffer.from('open_standby', 'utf8'); // 12 bytes
  const buf = new Uint8Array(tag.length + 32 + 32 + 8);
  let o = 0;
  buf.set(tag, o);
  o += tag.length;
  buf.set(vaultPda.toBytes(), o);
  o += 32;
  buf.set(financierSwig.toBytes(), o);
  o += 32;
  new DataView(buf.buffer).setBigUint64(o, cap, true);
  o += 8;
  if (o !== 84) throw new Error(`open_standby message wrong length: ${o}`);
  return buf;
}

/**
 * Message format for the USER leg of `close_standby` (what the user's passkey
 * signs; the on-chain handler verifies it via the secp256r1 precompile sibling):
 *
 *   bytes("close_standby") (13) || vaultPda (32) || financierSwig (32) = 77 bytes
 *
 * MUST match close_standby.rs byte-for-byte.
 */
export function buildCloseStandbyMessage(vaultPda: PublicKey, financierSwig: PublicKey): Uint8Array {
  const prefix = Buffer.from('close_standby', 'utf8');
  const out = new Uint8Array(prefix.length + 32 + 32);
  out.set(prefix, 0);
  out.set(vaultPda.toBytes(), prefix.length);
  out.set(financierSwig.toBytes(), prefix.length + 32);
  if (out.length !== 77) throw new Error(`close_standby message wrong length: ${out.length}`);
  return out;
}
