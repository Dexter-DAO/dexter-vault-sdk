/**
 * Vault account decoders (Anchor v2 layout).
 *
 * Two entry points sharing one byte layout:
 *  - readVaultOnchain → slim {exists, pendingVoucherCount, pendingWithdrawal}
 *  - readVaultFull    → full incl. swigAddress + dexterAuthority + activeSession
 *
 * v2 layout (programs/dexter-vault/src/state.rs::Vault):
 *      0     8   discriminator
 *      8     1   version u8 (= 2)
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
 *    196/148  1  active_session Option tag
 *            92  session body (if tag==1):
 *                32 session_pubkey
 *                 8 max_amount u64
 *                 8 expires_at i64
 *                32 allowed_counterparty
 *                 4 nonce u32
 *                 8 spent u64
 */

import { Connection, PublicKey } from '@solana/web3.js';
import type {
  PendingWithdrawal,
  ActiveSession,
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
const ACTIVE_SESSION_BODY_LEN = 92;

const EMPTY_FULL: VaultStateFull = {
  exists: false,
  version: 0,
  swigAddress: null,
  dexterAuthority: null,
  pendingVoucherCount: 0,
  activeSession: null,
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

/** Full read — adds swigAddress, dexterAuthority, activeSession. The /tab/settle path. */
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

  const activeSessionTagOffset = dexterAuthorityOffset + PUBKEY_LEN;
  let activeSession: ActiveSession | null = null;
  if (
    data.length > activeSessionTagOffset &&
    data[activeSessionTagOffset] === 1
  ) {
    const bodyStart = activeSessionTagOffset + 1;
    if (data.length >= bodyStart + ACTIVE_SESSION_BODY_LEN) {
      activeSession = {
        sessionPubkey: new Uint8Array(data.subarray(bodyStart, bodyStart + 32)),
        maxAmount: data.readBigUInt64LE(bodyStart + 32),
        expiresAt: Number(data.readBigInt64LE(bodyStart + 40)),
        allowedCounterparty: new PublicKey(
          data.subarray(bodyStart + 48, bodyStart + 80),
        ).toBase58(),
        nonce: data.readUInt32LE(bodyStart + 80),
        spent: data.readBigUInt64LE(bodyStart + 84),
      };
    }
  }

  return {
    exists: true,
    version,
    swigAddress,
    dexterAuthority,
    pendingVoucherCount,
    activeSession,
  };
}
