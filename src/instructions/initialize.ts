/**
 * initialize_vault — bootstrap a fresh vault PDA bound to a passkey.
 *
 * Verbatim port of dexter-api/src/vault/instructions.ts:142-160.
 */

import {
  PublicKey,
  TransactionInstruction,
  SystemProgram,
} from '@solana/web3.js';

import { DEXTER_VAULT_PROGRAM_ID, DISCRIMINATORS } from '../constants/index.js';

function encodeFixedBytes(buf: Uint8Array, len: number): Buffer {
  if (buf.length !== len) {
    throw new Error(`expected ${len} bytes, got ${buf.length}`);
  }
  return Buffer.from(buf);
}

function encodeU32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value >>> 0, 0);
  return out;
}

export interface InitializeVaultParams {
  vaultPda: PublicKey;
  payer: PublicKey;
  dexterAuthority: PublicKey; // session master — must sign; bound as the vault's authority
  passkeyPubkey: Uint8Array; // 33-byte SEC1 compressed P-256
  /** v2: cooling-off is u32 seconds (negative was meaningless; u32 caps at ~136y). */
  coolingOffSeconds: number;
  /**
   * v2: opaque 32-byte identity claim, operator-defined. Renamed from
   * supabaseUserId. dexter-api writes the 16-byte Supabase UUID into the
   * first 16 bytes and zero-pads the rest. The PDA seed uses only the
   * leading 16 bytes (`identity_claim[..16]`) which preserves the
   * derivation across the rename.
   */
  identityClaim: Uint8Array; // 32 bytes
}

export function buildInitializeVaultInstruction(p: InitializeVaultParams): TransactionInstruction {
  const argsBuf = Buffer.concat([
    encodeFixedBytes(p.passkeyPubkey, 33),
    encodeU32(p.coolingOffSeconds),
    encodeFixedBytes(p.identityClaim, 32),
  ]);
  const data = Buffer.concat([Buffer.from(DISCRIMINATORS.initialize_vault), argsBuf]);

  return new TransactionInstruction({
    programId: DEXTER_VAULT_PROGRAM_ID,
    keys: [
      { pubkey: p.vaultPda, isSigner: false, isWritable: true },
      { pubkey: p.payer, isSigner: true, isWritable: true },
      { pubkey: p.dexterAuthority, isSigner: true, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}
