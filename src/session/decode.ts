/**
 * SessionAccount decoder — V6 per-counterparty session PDA.
 *
 * Byte layout (verified against programs/dexter-vault/src/state.rs on the
 * deployed feat/vault-v6-multisession build, 2026-06-09):
 *   0   8  Anchor discriminator
 *   8   1  version u8        (0 = never-touched/cleared; 1 = live-written)
 *   9   1  bump u8
 *  10  32  vault
 *  42  32  session_pubkey
 *  74   8  max_amount u64
 *  82   8  expires_at i64
 *  90  32  allowed_counterparty
 * 122   4  nonce u32
 * 126   8  spent u64
 * 134   8  current_outstanding u64
 * 142   8  max_revolving_capacity u64
 * 150   8  crystallized_cumulative u64
 * 158   4  last_locked_sequence u32   (total 162)
 *
 * `version` is the PROGRAM's liveness field, NOT the Anchor discriminator —
 * Anchor sets the discriminator on init_if_needed BEFORE the handler runs, so
 * discriminator-present proves nothing. version === 0 is authoritative
 * "no live session here" (cleared by revoke, the register-time expiry sweep,
 * or a failed first register).
 */
import { PublicKey } from '@solana/web3.js';
import { SESSION_ACCOUNT_DISCRIMINATOR, SESSION_ACCOUNT_SIZE } from '../constants/index.js';
import type { SessionAccountState } from '../types.js';

export function decodeSessionAccount(address: PublicKey, data: Buffer | Uint8Array): SessionAccountState {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length !== SESSION_ACCOUNT_SIZE) {
    throw new Error(`SessionAccount ${address.toBase58()} wrong size: ${buf.length}, expected ${SESSION_ACCOUNT_SIZE}`);
  }
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== SESSION_ACCOUNT_DISCRIMINATOR[i]) {
      throw new Error(`SessionAccount ${address.toBase58()} wrong discriminator (not a SessionAccount)`);
    }
  }
  return {
    address: address.toBase58(),
    version: buf.readUInt8(8),
    bump: buf.readUInt8(9),
    vault: new PublicKey(buf.subarray(10, 42)).toBase58(),
    session: {
      sessionPubkey: new Uint8Array(buf.subarray(42, 74)),
      maxAmount: buf.readBigUInt64LE(74),
      expiresAt: Number(buf.readBigInt64LE(82)),
      allowedCounterparty: new PublicKey(buf.subarray(90, 122)).toBase58(),
      nonce: buf.readUInt32LE(122),
      spent: buf.readBigUInt64LE(126),
      currentOutstanding: buf.readBigUInt64LE(134),
      maxRevolvingCapacity: buf.readBigUInt64LE(142),
      crystallizedCumulative: buf.readBigUInt64LE(150),
      lastLockedSequence: buf.readUInt32LE(158),
    },
  };
}

/** Liveness = written (version 1) AND unexpired. `nowSeconds` injectable for tests. */
export function isSessionLive(
  s: SessionAccountState,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  return s.version === 1 && s.session.expiresAt > nowSeconds;
}
