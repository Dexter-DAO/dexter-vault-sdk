/**
 * register_session_key — authorize a session ed25519 key under a vault.
 *
 * Verbatim port of dexter-x402-sdk/src/tab/instructions.ts:168-194.
 *
 * Accounts (in declaration order — Anchor is strict):
 *   0. [writable]            vault                — the Vault PDA being mutated
 *   1. [readonly]            instructions_sysvar  — address-constrained
 *
 * Args (Borsh-serialized after the 8-byte discriminator):
 *   session_pubkey: [u8; 32]
 *   max_amount: u64
 *   expires_at: i64
 *   allowed_counterparty: Pubkey (32 bytes)
 *   nonce: u32
 *   max_revolving_capacity: u64
 *   client_data_json: Vec<u8>
 *   authenticator_data: Vec<u8>
 */

import { PublicKey, TransactionInstruction } from '@solana/web3.js';

import {
  DEXTER_VAULT_PROGRAM_ID,
  INSTRUCTIONS_SYSVAR_ID,
  DISCRIMINATORS,
} from '../constants/index.js';

function encodeU64LE(value: bigint): Uint8Array {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setBigUint64(0, value, true);
  return buf;
}

function encodeI64LE(value: bigint): Uint8Array {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setBigInt64(0, value, true);
  return buf;
}

function encodeU32LE(value: number): Uint8Array {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, value >>> 0, true);
  return buf;
}

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

export interface BuildRegisterSessionKeyArgs {
  vaultPda: PublicKey;
  sessionPubkey: Uint8Array;        // 32 bytes, ed25519
  maxAmount: bigint;
  expiresAt: bigint;                 // i64 seconds
  allowedCounterparty: PublicKey;
  nonce: number;                     // u32
  maxRevolvingCapacity: bigint;      // NEW — u64, must be > 0 (program enforces)
  clientDataJSON: Uint8Array;        // WebAuthn ceremony output
  authenticatorData: Uint8Array;     // WebAuthn ceremony output
}

export function buildRegisterSessionKeyInstruction(
  args: BuildRegisterSessionKeyArgs,
): TransactionInstruction {
  if (args.sessionPubkey.length !== 32) {
    throw new Error(`sessionPubkey must be 32 bytes, got ${args.sessionPubkey.length}`);
  }

  const data = concatBytes(
    DISCRIMINATORS.register_session_key,
    args.sessionPubkey,
    encodeU64LE(args.maxAmount),
    encodeI64LE(args.expiresAt),
    args.allowedCounterparty.toBytes(),
    encodeU32LE(args.nonce),
    encodeU64LE(args.maxRevolvingCapacity),
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
