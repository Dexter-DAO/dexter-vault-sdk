/**
 * Shared raw SessionAccount byte fixture (162 bytes). Offsets per the
 * canonical layout table in the src/session/decode.ts header:
 *   0   8  Anchor discriminator
 *   8   1  version u8
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
 * 158   4  last_locked_sequence u32
 */
import { PublicKey } from '@solana/web3.js';
import { SESSION_ACCOUNT_DISCRIMINATOR, SESSION_ACCOUNT_SIZE } from '../../src/constants/index.js';

/** ~2096, past any test clock. */
export const FAR_FUTURE_EXPIRY = 4_000_000_000n;

export function rawSessionAccount(opts: {
  vault: PublicKey;
  counterparty: PublicKey;
  version?: number;
  expiresAt?: bigint;
  spent?: bigint;
  maxAmount?: bigint;
  currentOutstanding?: bigint;
  sessionPubkey?: Uint8Array;
  nonce?: number;
}): Buffer {
  const data = Buffer.alloc(SESSION_ACCOUNT_SIZE);
  Buffer.from(SESSION_ACCOUNT_DISCRIMINATOR).copy(data, 0);
  data.writeUInt8(opts.version ?? 1, 8);                                            // version
  data.writeUInt8(255, 9);                                                          // bump
  opts.vault.toBuffer().copy(data, 10);                                             // vault
  Buffer.from(opts.sessionPubkey ?? new Uint8Array(32).fill(0x07)).copy(data, 42);  // session_pubkey
  data.writeBigUInt64LE(opts.maxAmount ?? 0n, 74);                                  // max_amount
  data.writeBigInt64LE(opts.expiresAt ?? FAR_FUTURE_EXPIRY, 82);                    // expires_at
  opts.counterparty.toBuffer().copy(data, 90);                                      // allowed_counterparty
  data.writeUInt32LE(opts.nonce ?? 42, 122);                                        // nonce
  data.writeBigUInt64LE(opts.spent ?? 0n, 126);                                     // spent
  data.writeBigUInt64LE(opts.currentOutstanding ?? 0n, 134);                        // current_outstanding
  return data;
}
