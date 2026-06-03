/**
 * SIMD-0075 secp256r1 precompile builder + WebAuthn precompile message
 * assembler.
 *
 * Place a secp256r1 verify instruction IMMEDIATELY before any vault
 * instruction that takes a passkey-signed op (set_swig, register_session_key,
 * revoke_session_key, request_withdrawal, finalize_withdrawal, force_release,
 * rotate_passkey, prove_passkey). The vault program reads
 * SYSVAR_INSTRUCTIONS to introspect the sibling and rejects unless it
 * verifies.
 */

import { TransactionInstruction } from '@solana/web3.js';
import { SECP256R1_PROGRAM_ID } from '../constants/index.js';

export const SIGNATURE_OFFSETS_SERIALIZED_SIZE = 14;
export const SIGNATURE_SERIALIZED_SIZE = 64;
export const COMPRESSED_PUBKEY_SERIALIZED_SIZE = 33;
export const PRECOMPILE_DATA_START = 2;

export function buildSecp256r1VerifyInstruction(
  publicKey: Uint8Array, // 33-byte compressed P-256
  signature: Uint8Array, // 64-byte (r||s)
  message: Uint8Array,
): TransactionInstruction {
  if (publicKey.length !== COMPRESSED_PUBKEY_SERIALIZED_SIZE) {
    throw new Error(`expected ${COMPRESSED_PUBKEY_SERIALIZED_SIZE}-byte pubkey`);
  }
  if (signature.length !== SIGNATURE_SERIALIZED_SIZE) {
    throw new Error(`expected ${SIGNATURE_SERIALIZED_SIZE}-byte signature`);
  }

  const signatureOffset = PRECOMPILE_DATA_START + SIGNATURE_OFFSETS_SERIALIZED_SIZE;
  const publicKeyOffset = signatureOffset + SIGNATURE_SERIALIZED_SIZE;
  const messageOffset = publicKeyOffset + COMPRESSED_PUBKEY_SERIALIZED_SIZE;
  const messageSize = message.length;
  const totalLen = messageOffset + messageSize;
  const data = Buffer.alloc(totalLen);

  data[0] = 1;
  data[1] = 0;
  data.writeUInt16LE(signatureOffset, PRECOMPILE_DATA_START + 0);
  data.writeUInt16LE(0xffff, PRECOMPILE_DATA_START + 2);
  data.writeUInt16LE(publicKeyOffset, PRECOMPILE_DATA_START + 4);
  data.writeUInt16LE(0xffff, PRECOMPILE_DATA_START + 6);
  data.writeUInt16LE(messageOffset, PRECOMPILE_DATA_START + 8);
  data.writeUInt16LE(messageSize, PRECOMPILE_DATA_START + 10);
  data.writeUInt16LE(0xffff, PRECOMPILE_DATA_START + 12);

  Buffer.from(signature).copy(data, signatureOffset);
  Buffer.from(publicKey).copy(data, publicKeyOffset);
  Buffer.from(message).copy(data, messageOffset);

  return new TransactionInstruction({
    keys: [],
    programId: SECP256R1_PROGRAM_ID,
    data,
  });
}

/**
 * Build the bytes the precompile verifies against the WebAuthn signature:
 *   authenticatorData || SHA-256(clientDataJSON)
 *
 * Works in Node (via `node:crypto`) and the browser (via SubtleCrypto).
 */
export async function buildPrecompileMessage(
  clientDataJSON: Uint8Array,
  authenticatorData: Uint8Array,
): Promise<Uint8Array> {
  const subtle = (globalThis.crypto as any)?.subtle;
  let clientDataHash: Uint8Array;
  if (subtle) {
    const buf = await subtle.digest('SHA-256', clientDataJSON);
    clientDataHash = new Uint8Array(buf);
  } else {
    const { createHash } = await import('node:crypto');
    clientDataHash = createHash('sha256').update(clientDataJSON).digest();
  }
  const out = new Uint8Array(authenticatorData.length + 32);
  out.set(authenticatorData, 0);
  out.set(clientDataHash, authenticatorData.length);
  return out;
}
