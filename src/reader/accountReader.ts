/**
 * Vault account decoders (Anchor layout, V6).
 *
 * Two entry points sharing one byte layout:
 *  - readVaultOnchain → slim {exists, pendingVoucherCount, pendingWithdrawal}
 *  - readVaultFull    → full incl. swigAddress + dexterAuthority + liveSessionCount
 *
 * V6 layout (programs/dexter-vault/src/state.rs::Vault):
 *      0     8   discriminator
 *      8     1   version u8 (= 6)
 *      9     1   bump u8
 *     10    33   passkey_pubkey
 *     43    32   swig_address
 *     75     4   cooling_off_seconds u32
 *     79     4   pending_voucher_count u32
 *     83     1   pending_withdrawal Option tag
 *            48  pending_withdrawal body (if tag==1):
 *                  8  amount u64
 *                 32  destination
 *                  8  requested_at i64
 *    132/84  32  identity_claim    (132 if withdrawal present, else 84)
 *    164/116 32  dexter_authority  (164 if withdrawal present, else 116)
 *    196/148  1  live_session_count u8
 *    197/149  8  outstanding_locked_amount u64 (sum of unsettled LockedClaims)
 *            ... further odometer/credit fields follow on-chain; not decoded here.
 *
 * V5→V6 change: the byte after dexter_authority WAS an active_session Option
 * tag (+92-byte inline body); V6 replaced it with live_session_count u8 —
 * sessions now live in per-counterparty SessionAccount PDAs (src/session/).
 * HAZARD: the V5 reader mis-decoded V6 bytes as a session (the count byte
 * read as an Option tag, odometers read as money fields) — never resurrect
 * the Option-tag read.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import type {
  PendingWithdrawal,
  VaultOnchainState,
  VaultStateFull,
} from '../types.js';

// ── Offsets ──────────────────────────────────────────────────────────────
const VERSION_OFFSET = 8;
const SWIG_ADDRESS_OFFSET = 43;
const PENDING_VOUCHER_COUNT_OFFSET = 79;
const PENDING_WITHDRAWAL_TAG_OFFSET = 83;
const PENDING_WITHDRAWAL_AMOUNT_OFFSET = 84;
const PENDING_WITHDRAWAL_DESTINATION_OFFSET = 92;
const PENDING_WITHDRAWAL_REQUESTED_AT_OFFSET = 124;
const PENDING_WITHDRAWAL_BODY_LEN = 48;
const PENDING_WITHDRAWAL_BODY_START = PENDING_WITHDRAWAL_TAG_OFFSET + 1;
const IDENTITY_CLAIM_LEN = 32;
const PUBKEY_LEN = 32;

/**
 * Decode a borsh `Option<T>`: 1 tag byte (0 = None, 1 = Some) then `size` bytes
 * of body iff Some. Returns [value|null, nextOffset]. Centralizes the variable-
 * offset hazard (a missed tag-branch reads `size` bytes off and decodes garbage —
 * the exact V5→V6 mis-decode this file's header warns about). Length-guarded.
 */
function readOption<T>(
  data: Buffer,
  offset: number,
  size: number,
  parse: (b: Buffer) => T,
): [T | null, number] {
  if (offset >= data.length) return [null, offset];
  if (data[offset] === 1 && data.length >= offset + 1 + size) {
    return [parse(data.subarray(offset + 1, offset + 1 + size)), offset + 1 + size];
  }
  return [null, offset + 1];
}

const EMPTY_FULL: VaultStateFull = {
  exists: false,
  version: 0,
  swigAddress: null,
  dexterAuthority: null,
  pendingVoucherCount: 0,
  liveSessionCount: 0,
  outstandingLockedAmount: '0',
  borrowed: '0',
  standbyBacker: null,
  standbyCap: '0',
  borrowRecoveryAt: null,
};

/** Slim read — the shape dexter-api's existing /status routes return. */
export async function readVaultOnchain(
  conn: Connection,
  vaultPda: PublicKey,
): Promise<VaultOnchainState> {
  const account = await conn.getAccountInfo(vaultPda, 'confirmed');
  if (!account) {
    return { exists: false, pendingVoucherCount: 0, pendingWithdrawal: null };
  }
  const data = account.data;
  const pendingVoucherCount = data.readUInt32LE(PENDING_VOUCHER_COUNT_OFFSET);

  let pendingWithdrawal: PendingWithdrawal | null = null;
  if (data[PENDING_WITHDRAWAL_TAG_OFFSET] === 1) {
    pendingWithdrawal = {
      amount: data.readBigUInt64LE(PENDING_WITHDRAWAL_AMOUNT_OFFSET).toString(),
      destination: new PublicKey(
        data.subarray(
          PENDING_WITHDRAWAL_DESTINATION_OFFSET,
          PENDING_WITHDRAWAL_DESTINATION_OFFSET + 32,
        ),
      ).toBase58(),
      requestedAt: Number(data.readBigInt64LE(PENDING_WITHDRAWAL_REQUESTED_AT_OFFSET)),
    };
  }

  return { exists: true, pendingVoucherCount, pendingWithdrawal };
}

/** Full read — adds swigAddress, dexterAuthority, liveSessionCount. The /tab/settle path. */
export async function readVaultFull(
  conn: Connection,
  vaultPda: PublicKey,
): Promise<VaultStateFull> {
  const account = await conn.getAccountInfo(vaultPda, 'confirmed');
  if (!account) return EMPTY_FULL;
  const data = account.data;
  if (data.length < SWIG_ADDRESS_OFFSET + PUBKEY_LEN) return EMPTY_FULL;

  const version = data.readUInt8(VERSION_OFFSET);
  const swigAddress = new PublicKey(
    data.subarray(SWIG_ADDRESS_OFFSET, SWIG_ADDRESS_OFFSET + PUBKEY_LEN),
  ).toBase58();
  const pendingVoucherCount = data.readUInt32LE(PENDING_VOUCHER_COUNT_OFFSET);

  const withdrawalTag = data[PENDING_WITHDRAWAL_TAG_OFFSET];
  const afterWithdrawal =
    PENDING_WITHDRAWAL_BODY_START +
    (withdrawalTag === 1 ? PENDING_WITHDRAWAL_BODY_LEN : 0);

  const dexterAuthorityOffset = afterWithdrawal + IDENTITY_CLAIM_LEN;
  if (data.length < dexterAuthorityOffset + PUBKEY_LEN) {
    return { ...EMPTY_FULL, exists: true, version, swigAddress, pendingVoucherCount };
  }
  const dexterAuthority = new PublicKey(
    data.subarray(dexterAuthorityOffset, dexterAuthorityOffset + PUBKEY_LEN),
  ).toBase58();

  const liveSessionCountOffset = dexterAuthorityOffset + PUBKEY_LEN;
  const liveSessionCount =
    data.length > liveSessionCountOffset ? data.readUInt8(liveSessionCountOffset) : 0;

  // outstanding_locked_amount: u64 sits immediately after live_session_count.
  const outstandingLockedOffset = liveSessionCountOffset + 1;
  const hasOutstanding = data.length >= outstandingLockedOffset + 8;
  const outstandingLockedAmount = hasOutstanding
    ? data.readBigUInt64LE(outstandingLockedOffset).toString()
    : '0';

  // ── V5 credit tail (moving cursor: standby_backer is Option<Pubkey>) ──
  // Defaults if the account is a pre-V5 layout / too short to carry the tail.
  let borrowed = '0';
  let standbyBacker: string | null = null;
  let standbyCap = '0';
  let borrowRecoveryAt: number | null = null;

  const borrowedOffset = outstandingLockedOffset + 24; // skip outstanding, crystallized, settled
  if (hasOutstanding && data.length >= borrowedOffset + 8) {
    borrowed = data.readBigUInt64LE(borrowedOffset).toString();
    // standby_backer: Option<Pubkey> — the one variable-length field. readOption
    // returns the value and the offset AFTER it, so standby_cap reads correctly
    // whether the pubkey was present (Some) or absent (None).
    const [backer, afterBacker] = readOption(
      data, borrowedOffset + 8, PUBKEY_LEN, (b) => new PublicKey(b).toBase58(),
    );
    standbyBacker = backer;
    if (data.length >= afterBacker + 8) {
      standbyCap = data.readBigUInt64LE(afterBacker).toString();
      const [recoveryAt] = readOption(
        data, afterBacker + 8, 8, (b) => Number(b.readBigInt64LE(0)),
      );
      borrowRecoveryAt = recoveryAt;
    }
  }

  return {
    exists: true,
    version,
    swigAddress,
    dexterAuthority,
    pendingVoucherCount,
    liveSessionCount,
    outstandingLockedAmount,
    borrowed,
    standbyBacker,
    standbyCap,
    borrowRecoveryAt,
  };
}
