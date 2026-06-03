/**
 * set_swig — bind a Swig state PDA into the vault (passkey-signed).
 *
 * Verbatim port of dexter-api/src/vault/instructions.ts:173-189.
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

function encodePubkey(key: PublicKey): Buffer {
  return Buffer.from(key.toBytes());
}

export interface SetSwigParams {
  vaultPda: PublicKey;
  swigAddress: PublicKey;
  clientDataJSON: Uint8Array;
  authenticatorData: Uint8Array;
}

export function buildSetSwigInstruction(p: SetSwigParams): TransactionInstruction {
  const argsBuf = Buffer.concat([
    encodePubkey(p.swigAddress),
    encodeBytesVec(p.clientDataJSON),
    encodeBytesVec(p.authenticatorData),
  ]);
  const data = Buffer.concat([Buffer.from(DISCRIMINATORS.set_swig), argsBuf]);

  return new TransactionInstruction({
    programId: DEXTER_VAULT_PROGRAM_ID,
    keys: [
      { pubkey: p.vaultPda, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    ],
    data,
  });
}
