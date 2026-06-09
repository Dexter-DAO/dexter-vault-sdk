/**
 * revoke_session_key — invalidate one session under a vault.
 *
 * V6 multi-session layout: the session lives in its own SessionAccount PDA
 * ([b"session", vault, allowed_counterparty]), not in vault.active_session.
 * The handler reads the session_pubkey FROM THE PDA and embeds it in the
 * 128-byte signed revoke message it rebuilds for verification — so callers
 * must fetch the live session (fetchSessionAccount) to construct the
 * signable message. That is the replay protection: a stale revocation
 * (signed against an old session_pubkey) cannot kill a rotated session,
 * because the pubkey in the signed message won't match what the PDA holds.
 *
 * Accounts (in declaration order — Anchor is strict):
 *   0. [writable]  vault                — the Vault PDA
 *   1. [writable]  session              — SessionAccount PDA
 *                                          [b"session", vault, allowed_counterparty]
 *   2. [readonly]  instructions_sysvar  — address-constrained
 *
 * Args (Borsh after the 8-byte discriminator):
 *   allowed_counterparty: Pubkey (32 bytes)
 *   client_data_json: Vec<u8>
 *   authenticator_data: Vec<u8>
 */

import { PublicKey, TransactionInstruction } from '@solana/web3.js';

import {
  DEXTER_VAULT_PROGRAM_ID,
  INSTRUCTIONS_SYSVAR_ID,
  DISCRIMINATORS,
} from '../constants/index.js';
import { deriveSessionPda } from '../session/index.js';

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
  /** V6: names the session PDA being revoked (Borsh arg AND PDA seed). */
  allowedCounterparty: PublicKey;
  clientDataJSON: Uint8Array;
  authenticatorData: Uint8Array;
}

export function buildRevokeSessionKeyInstruction(
  args: BuildRevokeSessionKeyArgs,
): TransactionInstruction {
  const data = concatBytes(
    DISCRIMINATORS.revoke_session_key,
    args.allowedCounterparty.toBytes(),
    encodeVecU8(args.clientDataJSON),
    encodeVecU8(args.authenticatorData),
  );

  const [sessionPda] = deriveSessionPda(args.vaultPda, args.allowedCounterparty);

  return new TransactionInstruction({
    keys: [
      { pubkey: args.vaultPda, isSigner: false, isWritable: true },
      { pubkey: sessionPda, isSigner: false, isWritable: true },
      { pubkey: INSTRUCTIONS_SYSVAR_ID, isSigner: false, isWritable: false },
    ],
    programId: DEXTER_VAULT_PROGRAM_ID,
    data: Buffer.from(data),
  });
}
