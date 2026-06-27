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
 *             8  total_crystallized u64   (odometer; skipped, not surfaced)
 *             8  total_settled u64        (odometer; skipped, not surfaced)
 *            32  node pubkey              (welded PrincipalNode; DECODED below as
 *                                          `node`, null when default/unset)
 *   The V6 graph tail is fixed-layout (no Option fields after the odometers) —
 *   see the inline note near the `node` decode for the authoritative offsets.
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
  PrincipalNodeState,
  RateCapState,
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
  node: null,
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

/**
 * Pure decoder for a Vault account's raw data — the body of readVaultFull with
 * NO RPC. Exported so a caller that already holds the bytes (a
 * getProgramAccounts scan — see scanCreditBook) decodes without an extra
 * getAccountInfo round-trip per vault. Returns EMPTY_FULL (exists:false) for
 * data too short to be a V6 vault. The caller supplies the account address.
 */
export function decodeVaultFull(data: Buffer): VaultStateFull {
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

  // ── V6 graph tail (fixed layout, no Option fields after the odometers) ──
  //   outstanding_locked u64 | total_crystallized u64 | total_settled u64 | node pk
  // The V5 inline credit tail (borrowed / standby_backer / standby_cap /
  // borrow_recovery_at) is GONE — credit state moved onto the PrincipalNode graph.
  const nodeOffset = outstandingLockedOffset + 24; // skip outstanding, crystallized, settled
  let node: string | null = null;
  if (hasOutstanding && data.length >= nodeOffset + PUBKEY_LEN) {
    node = new PublicKey(data.subarray(nodeOffset, nodeOffset + PUBKEY_LEN)).toBase58();
  }

  return {
    exists: true,
    version,
    swigAddress,
    dexterAuthority,
    pendingVoucherCount,
    liveSessionCount,
    outstandingLockedAmount,
    node,
  };
}

// ── PrincipalNode (recourse graph) ─────────────────────────────────────────

const PRINCIPAL_NODE_DISC_LEN = 8;

/**
 * Pure decoder for a PrincipalNode account's raw data (NO RPC). Field-for-field
 * mirror of programs/dexter-vault/src/state.rs::PrincipalNode. Uses a moving
 * cursor because `parent`, `root_attestation`, `cap.ceiling`, and
 * `borrow_recovery_at` are borsh `Option`s (1 tag byte + body iff Some) — a
 * missed tag-branch reads the rest of the struct off-by-`size`, the same hazard
 * decodeVaultFull guards. Throws on data too short to be a PrincipalNode.
 */
export function decodePrincipalNode(data: Buffer): PrincipalNodeState {
  let o = PRINCIPAL_NODE_DISC_LEN; // skip the 8-byte account discriminator
  const u8 = () => { const v = data.readUInt8(o); o += 1; return v; };
  const u16 = () => { const v = data.readUInt16LE(o); o += 2; return v; };
  const u32 = () => { const v = data.readUInt32LE(o); o += 4; return v; };
  const u64 = () => { const v = data.readBigUInt64LE(o).toString(); o += 8; return v; };
  const i64 = () => { const v = Number(data.readBigInt64LE(o)); o += 8; return v; };
  const pk = () => { const v = new PublicKey(data.subarray(o, o + PUBKEY_LEN)).toBase58(); o += PUBKEY_LEN; return v; };
  const bytes32 = () => { const v = Uint8Array.from(data.subarray(o, o + 32)); o += 32; return v; };
  const optPk = (): string | null => { const tag = u8(); return tag === 1 ? pk() : null; };
  const optU64 = (): string | null => { const tag = u8(); return tag === 1 ? u64() : null; };
  const optI64 = (): number | null => { const tag = u8(); return tag === 1 ? i64() : null; };

  if (data.length < PRINCIPAL_NODE_DISC_LEN + 2 + 32 + 32) {
    throw new Error('decodePrincipalNode: data too short');
  }

  const version = u8();
  const bump = u8();
  const nodeId = bytes32();
  const controller = pk();
  const parent = optPk();
  const rootAttestation = optPk();
  const cap: RateCapState = {
    rateAmount: u64(),
    periodSecs: u32(),
    bucket: u64(),
    lastRefill: i64(),
    ceiling: optU64(),
    burstMultiple: u8(),
  };
  const borrowed = u64();
  const subtreeDraw = u64();
  const borrowRecoveryAt = optI64();
  const shortfall = u64();
  const frozen = u8() === 1;
  const childCount = u32();
  const accruedFee = u64();
  const rateBps = u16();
  const lastAccrual = i64();

  return {
    version, bump, nodeId, controller, parent, rootAttestation, cap,
    borrowed, subtreeDraw, borrowRecoveryAt, shortfall, frozen,
    childCount, accruedFee, rateBps, lastAccrual,
  };
}

/** Fetch + decode a single PrincipalNode by PDA. Returns null if absent. */
export async function readPrincipalNode(
  conn: Connection,
  nodePda: PublicKey,
): Promise<PrincipalNodeState | null> {
  const account = await conn.getAccountInfo(nodePda, 'confirmed');
  if (!account) return null;
  return decodePrincipalNode(account.data);
}

/**
 * Walk the delegation graph UP from `nodePda` following stored `parent` pointers
 * until a parent-less root, returning the FULL path leaf→…→root INCLUSIVE of the
 * starting node (child→parent order). This is the off-chain mirror of the
 * on-chain `traverse_authenticated` chain; builders that need the program's
 * `remaining_accounts` (which EXCLUDES the leaf) take `path.slice(1)` — the
 * GraphClient facade does that slice in ONE place (anti-bypass-drift).
 *
 * A cycle guard (max depth) prevents an infinite loop on corrupt data.
 */
export async function walkAncestors(
  conn: Connection,
  nodePda: PublicKey,
  maxDepth = 64,
): Promise<PublicKey[]> {
  const path: PublicKey[] = [];
  const seen = new Set<string>();
  let current: PublicKey | null = nodePda;
  while (current) {
    const key = current.toBase58();
    if (seen.has(key)) throw new Error(`walkAncestors: cycle detected at ${key}`);
    if (path.length >= maxDepth) throw new Error('walkAncestors: max depth exceeded');
    seen.add(key);
    path.push(current);
    const node = await readPrincipalNode(conn, current);
    if (!node) throw new Error(`walkAncestors: node ${key} not found`);
    current = node.parent ? new PublicKey(node.parent) : null;
  }
  return path;
}

/** Full read — adds swigAddress, dexterAuthority, liveSessionCount. The /tab/settle path. */
export async function readVaultFull(
  conn: Connection,
  vaultPda: PublicKey,
): Promise<VaultStateFull> {
  const account = await conn.getAccountInfo(vaultPda, 'confirmed');
  if (!account) return EMPTY_FULL;
  return decodeVaultFull(account.data);
}
