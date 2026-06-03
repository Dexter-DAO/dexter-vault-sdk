/**
 * rotate_passkey + rotate_dexter_authority — rotate the two long-lived
 * authorities bound to the vault.
 *
 * Verbatim port of dexter-api/src/vault/instructions.ts:340-383.
 */

import {
  PublicKey,
  TransactionInstruction,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from '@solana/web3.js';

import { DEXTER_VAULT_PROGRAM_ID, DISCRIMINATORS } from '../constants/index.js';

function encodeBytesVec(buf: Uint8Array): Buffer {
  const out = Buffer.alloc(4 + buf.length);
  out.writeUInt32LE(buf.length, 0);
  Buffer.from(buf).copy(out, 4);
  return out;
}

function encodeFixedBytes(buf: Uint8Array, len: number): Buffer {
  if (buf.length !== len) {
    throw new Error(`expected ${len} bytes, got ${buf.length}`);
  }
  return Buffer.from(buf);
}

function encodePubkey(key: PublicKey): Buffer {
  return Buffer.from(key.toBytes());
}

// ── rotate_passkey  (current passkey signs → new passkey) ─────────────────

export interface RotatePasskeyParams {
  vaultPda: PublicKey;
  newPasskeyPubkey: Uint8Array; // 33-byte SEC1 compressed P-256
  clientDataJSON: Uint8Array; // signed by the CURRENT passkey
  authenticatorData: Uint8Array;
}

/** Op message the current passkey must sign: "rotate_passkey" || new_pubkey. */
export function buildRotatePasskeyInstruction(p: RotatePasskeyParams): TransactionInstruction {
  const argsBuf = Buffer.concat([
    encodeFixedBytes(p.newPasskeyPubkey, 33),
    encodeBytesVec(p.clientDataJSON),
    encodeBytesVec(p.authenticatorData),
  ]);
  const data = Buffer.concat([Buffer.from(DISCRIMINATORS.rotate_passkey), argsBuf]);

  return new TransactionInstruction({
    programId: DEXTER_VAULT_PROGRAM_ID,
    keys: [
      { pubkey: p.vaultPda, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ── rotate_dexter_authority  (current authority signs → new authority) ────

export interface RotateDexterAuthorityParams {
  vaultPda: PublicKey;
  currentDexterAuthority: PublicKey; // must sign; must equal vault.dexter_authority (has_one)
  newDexterAuthority: PublicKey;
}

export function buildRotateDexterAuthorityInstruction(
  p: RotateDexterAuthorityParams,
): TransactionInstruction {
  const data = Buffer.concat([
    Buffer.from(DISCRIMINATORS.rotate_dexter_authority),
    encodePubkey(p.newDexterAuthority),
  ]);

  return new TransactionInstruction({
    programId: DEXTER_VAULT_PROGRAM_ID,
    keys: [
      { pubkey: p.vaultPda, isSigner: false, isWritable: true },
      { pubkey: p.currentDexterAuthority, isSigner: true, isWritable: false },
    ],
    data,
  });
}
