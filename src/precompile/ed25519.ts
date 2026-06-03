/**
 * Solana Ed25519 sigverify precompile builder.
 *
 * Layout matches solana-sdk/sdk/src/ed25519_instruction.rs byte-for-byte:
 *   u8 numSigs + u8 padding + 14-byte SignatureOffsets +
 *   contiguous pubkey(32) || signature(64) || message
 *
 * Place this BEFORE vault::settle_tab_voucher (or any future ix needing
 * session-key verification) in the same tx.
 */

import { TransactionInstruction } from '@solana/web3.js';
import { ED25519_PROGRAM_ID } from '../constants/index.js';

export function buildEd25519VerifyInstruction(
  pubkey: Uint8Array,    // 32 bytes
  signature: Uint8Array, // 64 bytes
  message: Uint8Array,
): TransactionInstruction {
  if (pubkey.length !== 32) throw new Error('pubkey must be 32 bytes');
  if (signature.length !== 64) throw new Error('signature must be 64 bytes');

  const NUM_SIG = 1;
  const PADDING = 0;
  const HEADER_LEN = 2;
  const OFFSETS_LEN = 14;
  const DATA_START = HEADER_LEN + OFFSETS_LEN;

  const data = Buffer.alloc(DATA_START + pubkey.length + signature.length + message.length);
  let off = 0;
  data.writeUInt8(NUM_SIG, off); off += 1;
  data.writeUInt8(PADDING, off); off += 1;

  const pubkeyOffset = DATA_START;
  const signatureOffset = pubkeyOffset + pubkey.length;
  const messageOffset = signatureOffset + signature.length;

  data.writeUInt16LE(signatureOffset, off); off += 2;
  data.writeUInt16LE(0xffff, off); off += 2;
  data.writeUInt16LE(pubkeyOffset, off); off += 2;
  data.writeUInt16LE(0xffff, off); off += 2;
  data.writeUInt16LE(messageOffset, off); off += 2;
  data.writeUInt16LE(message.length, off); off += 2;
  data.writeUInt16LE(0xffff, off); off += 2;

  Buffer.from(pubkey).copy(data, pubkeyOffset);
  Buffer.from(signature).copy(data, signatureOffset);
  Buffer.from(message).copy(data, messageOffset);

  return new TransactionInstruction({
    programId: ED25519_PROGRAM_ID,
    keys: [],
    data,
  });
}
