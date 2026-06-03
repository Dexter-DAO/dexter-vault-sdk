/**
 * revoke_session_key — invalidate the vault's current active session.
 *
 * Verbatim port of dexter-x402-sdk/src/tab/instructions.ts:215-232.
 *
 * Accounts: same as register (vault, instructions_sysvar).
 *
 * Args (Borsh after the 8-byte discriminator):
 *   client_data_json: Vec<u8>
 *   authenticator_data: Vec<u8>
 *
 * IMPORTANT: there is NO session_pubkey arg. The on-chain handler reads
 * the session pubkey from vault.active_session directly. The session
 * pubkey IS part of the 128-byte signed message (the program rebuilds it
 * from on-chain state), but it is NOT a tx arg.
 */

import { PublicKey, TransactionInstruction } from '@solana/web3.js';

import {
  DEXTER_VAULT_PROGRAM_ID,
  INSTRUCTIONS_SYSVAR_ID,
  DISCRIMINATORS,
} from '../constants/index.js';

function encodeVecU8(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length >>> 0, true);
  out.set(bytes, 4);
  return out;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export interface BuildRevokeSessionKeyArgs {
  vaultPda: PublicKey;
  clientDataJSON: Uint8Array;
  authenticatorData: Uint8Array;
}

export function buildRevokeSessionKeyInstruction(
  args: BuildRevokeSessionKeyArgs,
): TransactionInstruction {
  const data = concatBytes(
    DISCRIMINATORS.revoke_session_key,
    encodeVecU8(args.clientDataJSON),
    encodeVecU8(args.authenticatorData),
  );

  return new TransactionInstruction({
    keys: [
      { pubkey: args.vaultPda, isSigner: false, isWritable: true },
      { pubkey: INSTRUCTIONS_SYSVAR_ID, isSigner: false, isWritable: false },
    ],
    programId: DEXTER_VAULT_PROGRAM_ID,
    data: Buffer.from(data),
  });
}
