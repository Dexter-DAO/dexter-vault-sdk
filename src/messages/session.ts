/**
 * Byte-deterministic session-key message builders.
 *
 * MUST match the on-chain Rust handlers byte-for-byte:
 *   - register_session_key.rs::build_registration_message → sessionRegisterMessage (188 bytes, V2)
 *   - revoke_session_key.rs::build_revocation_message     → sessionRevokeMessage (128 bytes)
 *
 * Any drift makes every signature look forged to the on-chain handler.
 */

import type { PublicKey } from '@solana/web3.js';
import {
  OTS_SESSION_REGISTER_V2_DOMAIN,
  OTS_SESSION_REVOKE_V1_DOMAIN,
  OTS_REVOKE_AGENT_SPEND_V1_DOMAIN,
  OTS_ENABLE_AGENT_SPEND_V1_DOMAIN,
} from '../constants/index.js';

export interface SessionRegisterMessageArgs {
  programId: PublicKey;
  vaultPda: PublicKey;
  sessionPubkey: Uint8Array;       // 32 bytes
  maxAmount: bigint;
  expiresAt: bigint;
  allowedCounterparty: PublicKey;
  nonce: number;
  maxRevolvingCapacity: bigint;    // NEW — u64, must be > 0 (program enforces)
}

/**
 * 188-byte V2 session registration message. Layout:
 *    0   32  domain separator (OTS_SESSION_REGISTER_V2)
 *   32   32  program_id
 *   64   32  vault_pda
 *   96   32  session_pubkey
 *  128    8  max_amount (u64 LE)
 *  136    8  expires_at (i64 LE)
 *  144   32  allowed_counterparty
 *  176    4  nonce (u32 LE)
 *  180    8  max_revolving_capacity (u64 LE)
 *                                    ────
 *                                    188
 */
export function sessionRegisterMessage(args: SessionRegisterMessageArgs): Uint8Array {
  if (args.sessionPubkey.length !== 32) {
    throw new Error(`sessionPubkey must be 32 bytes, got ${args.sessionPubkey.length}`);
  }
  const buf = new Uint8Array(188);
  const view = new DataView(buf.buffer);
  let o = 0;
  buf.set(OTS_SESSION_REGISTER_V2_DOMAIN, o); o += 32;
  buf.set(args.programId.toBytes(), o); o += 32;
  buf.set(args.vaultPda.toBytes(), o); o += 32;
  buf.set(args.sessionPubkey, o); o += 32;
  view.setBigUint64(o, args.maxAmount, true); o += 8;
  view.setBigInt64(o, args.expiresAt, true); o += 8;
  buf.set(args.allowedCounterparty.toBytes(), o); o += 32;
  view.setUint32(o, args.nonce >>> 0, true); o += 4;
  view.setBigUint64(o, args.maxRevolvingCapacity, true); o += 8;
  if (o !== 188) {
    throw new Error(`internal: session register message wrong length ${o}, expected 188`);
  }
  return buf;
}

export interface SessionRevokeMessageArgs {
  programId: PublicKey;
  vaultPda: PublicKey;
  sessionPubkey: Uint8Array;
}

/**
 * 128-byte session revocation message. Layout:
 *    0   32  domain separator (REVOKE_DOMAIN)
 *   32   32  program_id
 *   64   32  vault_pda
 *   96   32  session_pubkey
 *                                    ────
 *                                    128
 */
export function sessionRevokeMessage(args: SessionRevokeMessageArgs): Uint8Array {
  if (args.sessionPubkey.length !== 32) {
    throw new Error(`sessionPubkey must be 32 bytes, got ${args.sessionPubkey.length}`);
  }
  const buf = new Uint8Array(128);
  let o = 0;
  buf.set(OTS_SESSION_REVOKE_V1_DOMAIN, o); o += 32;
  buf.set(args.programId.toBytes(), o); o += 32;
  buf.set(args.vaultPda.toBytes(), o); o += 32;
  buf.set(args.sessionPubkey, o); o += 32;
  if (o !== 128) {
    throw new Error(`internal: session revoke message wrong length ${o}, expected 128`);
  }
  return buf;
}

export interface RevokeAgentSpendMessageArgs {
  programId: PublicKey;
  vaultPda: PublicKey;
}

/**
 * 96-byte agent-spend OFF-switch message (anon-pay heal §5; AUTOMATIC mode).
 *
 * Under AUTOMATIC agent-spend the opt-out flag is the primary control surface,
 * so this is THE off-switch. The user signs these bytes with their passkey (the
 * bytes become the WebAuthn challenge); dexter-api verifies that signature
 * backend-side, then sets armingAllowed=false. No on-chain instruction reads
 * these bytes — verification is backend-only.
 *
 * Idempotent — NO nonce. Revoke is the fail-closed direction: replaying a
 * captured off-signature just turns it off again (harmless). Mirrors
 * sessionRevokeMessage. The on-switch (enableAgentSpendMessage) is the dangerous
 * direction and DOES carry replay protection.
 *
 * Layout:
 *    0   32  domain separator (OTS_REVOKE_AGENT_SPEND_V1)
 *   32   32  program_id
 *   64   32  vault_pda
 *                                    ───
 *                                    96
 */
export function revokeAgentSpendMessage(args: RevokeAgentSpendMessageArgs): Uint8Array {
  const buf = new Uint8Array(96);
  let o = 0;
  buf.set(OTS_REVOKE_AGENT_SPEND_V1_DOMAIN, o); o += 32;
  buf.set(args.programId.toBytes(), o); o += 32;
  buf.set(args.vaultPda.toBytes(), o); o += 32;
  if (o !== 96) {
    throw new Error(`internal: revoke agent-spend message wrong length ${o}, expected 96`);
  }
  return buf;
}

export interface EnableAgentSpendMessageArgs {
  programId: PublicKey;
  vaultPda: PublicKey;
  nonce: bigint;   // u64, server-issued single-use (the §5 verifier issues + burns it)
  expiry: bigint;  // i64 unix-seconds; the verifier rejects once now >= expiry
}

/**
 * 112-byte agent-spend ON-switch message (re-enable after revoke; AUTOMATIC mode).
 *
 * The DANGEROUS direction: a replayed enable could silently re-arm a wallet the
 * owner shut off, so unlike the off-switch this carries a server-issued
 * single-use `nonce` + an `expiry`. The §5 verifier issues the nonce on a
 * "request enable challenge" call, stores it pending, and on the signed enable
 * checks (a) nonce matches a live pending one, (b) now < expiry, then BURNS the
 * nonce and sets armingAllowed=true. Backend-verified, TS-only (no on-chain
 * handler reads these bytes).
 *
 * Scalars are packed at their natural little-endian width per this SDK's
 * convention (see sessionRegisterMessage: u64=8B, i64=8B), NOT padded to 32.
 *
 * Layout:
 *    0   32  domain separator (OTS_ENABLE_AGENT_SPEND_V1)
 *   32   32  program_id
 *   64   32  vault_pda
 *   96    8  nonce  (u64 LE)
 *  104    8  expiry (i64 LE)
 *                                    ───
 *                                    112
 */
export function enableAgentSpendMessage(args: EnableAgentSpendMessageArgs): Uint8Array {
  const buf = new Uint8Array(112);
  const view = new DataView(buf.buffer);
  let o = 0;
  buf.set(OTS_ENABLE_AGENT_SPEND_V1_DOMAIN, o); o += 32;
  buf.set(args.programId.toBytes(), o); o += 32;
  buf.set(args.vaultPda.toBytes(), o); o += 32;
  view.setBigUint64(o, args.nonce, true); o += 8;
  view.setBigInt64(o, args.expiry, true); o += 8;
  if (o !== 112) {
    throw new Error(`internal: enable agent-spend message wrong length ${o}, expected 112`);
  }
  return buf;
}
