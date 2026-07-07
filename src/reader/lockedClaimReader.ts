/**
 * LockedClaim decoder + fetcher — the crystallized (buyer-irrevocable)
 * reservation tier.
 *
 * Byte layout (programs/dexter-vault/src/state.rs::LockedClaim, cross-checked
 * against target/idl/dexter_vault.json):
 *    0   8  Anchor discriminator
 *    8   1  version u8
 *    9   1  bump u8
 *   10  32  vault                      ← gPA memcmp filter offset
 *   42  32  session_pubkey_at_lock
 *   74  32  voucher_hash
 *  106   8  amount u64
 *  114   8  created_at i64
 *  122  1+(8 if Some)  maturity_at Option<i64>        ← VARIABLE from here
 *    …  1+(8 if Some)  holder_recovery_at Option<i64>
 *    …  32  current_holder
 *    …   1  status u8 (0=Pending, 1=Settled, 2=Abandoned)
 *    …  1+(8 if Some)  settled_at Option<i64>
 *    …  1+(8 if Some)  recovered_at Option<i64>
 *    …  1+(32 if Some)  allowed_counterparty Option<Pubkey>   ← K-T1 #77 tail
 *
 * The fields after created_at sit at VARIABLE offsets because of the two
 * Option<i64> fields, so we decode with a MOVING CURSOR: read the 1-byte Borsh
 * Option tag (0x00 None / 0x01 Some), then advance 1 (None) or 9 (Some).
 *
 * TAIL-CARVE COMPATIBILITY (allowed_counterparty, K-T1 #77): the field exists
 * in TWO account generations. Legacy (pre-#77) claims are 191-byte accounts
 * (8 disc + 183 old INIT_SPACE) whose content ends at buffer offset ≤183
 * (8-byte disc + ≤175 Borsh bytes; settled_at/recovered_at are mutually
 * exclusive, so all-four-Options-Some is unreachable) — the allocation bytes
 * after the content are GUARANTEED-ZERO padding, so reading the Option tag
 * from them yields 0x00 → null. That is the
 * fork proof (state.rs::locked_claim_layout_tests): legacy claims MUST decode
 * as null, and we must NOT over-read past a 191-byte buffer. New (#77) claims
 * are 224-byte accounts (8 + 183 + 33) and always carry Some(seed-proven
 * seller). Mainnet ground truth 2026-07-06: all 44 live claims are 191 bytes.
 */
import { Connection, PublicKey } from '@solana/web3.js';
import {
  DEXTER_VAULT_PROGRAM_ID,
  LOCKED_CLAIM_DISCRIMINATOR,
  LOCKED_CLAIM_DISCRIMINATOR_B58,
  LOCKED_CLAIM_VAULT_OFFSET,
} from '../constants/index.js';
import type { LockedClaimState, LockedClaimStatus } from '../types.js';

const STATUS_BY_BYTE: Record<number, LockedClaimStatus> = {
  0: 'Pending',
  1: 'Settled',
  2: 'Abandoned',
};

/** Decode one LockedClaim account. Mirrors decodeSessionAccount, but walks the
 *  two Option<i64> fields with a moving cursor (variable layout). */
export function decodeLockedClaim(
  address: string,
  data: Buffer | Uint8Array,
): LockedClaimState {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== LOCKED_CLAIM_DISCRIMINATOR[i]) {
      throw new Error(`LockedClaim ${address} wrong discriminator (not a LockedClaim)`);
    }
  }

  // Fixed prefix runs through created_at (offset 114 + 8 = 122 bytes). Guard the
  // whole prefix up front so a truncated body throws a clean, addressed error
  // instead of an opaque Node RangeError from readBigInt64LE / new PublicKey().
  const FIXED_PREFIX_LEN = 122;
  if (buf.length < FIXED_PREFIX_LEN) {
    throw new Error(
      `LockedClaim ${address} truncated: expected >=${FIXED_PREFIX_LEN} bytes for fixed prefix, got ${buf.length}`,
    );
  }

  const version = buf.readUInt8(8);
  const bump = buf.readUInt8(9);
  const vault = new PublicKey(buf.subarray(10, 42)).toBase58();
  const sessionPubkeyAtLock = new PublicKey(buf.subarray(42, 74)).toBase58();
  const voucherHash = new PublicKey(buf.subarray(74, 106)).toBase58();
  const amount = buf.readBigUInt64LE(106).toString();
  const createdAt = Number(buf.readBigInt64LE(114));

  // Moving cursor from the first Option field onward.
  let cursor = 122;
  const requireBytes = (n: number): void => {
    if (cursor + n > buf.length) {
      throw new Error(
        `LockedClaim ${address} truncated at offset ${cursor}: expected ${n} more byte(s), buffer is ${buf.length}`,
      );
    }
  };
  const readOptionI64 = (): number | null => {
    requireBytes(1);
    const tag = buf.readUInt8(cursor);
    cursor += 1;
    if (tag === 0) return null;
    requireBytes(8);
    const v = Number(buf.readBigInt64LE(cursor));
    cursor += 8;
    return v;
  };

  const maturityAt = readOptionI64();
  const holderRecoveryAt = readOptionI64();
  requireBytes(32);
  const currentHolder = new PublicKey(buf.subarray(cursor, cursor + 32)).toBase58();
  cursor += 32;
  requireBytes(1);
  const statusByte = buf.readUInt8(cursor);
  cursor += 1;
  const status = STATUS_BY_BYTE[statusByte];
  if (status === undefined) {
    throw new Error(`LockedClaim ${address} unknown status byte: ${statusByte}`);
  }
  const settledAt = readOptionI64();
  const recoveredAt = readOptionI64();

  // K-T1 #77 tail: Option<Pubkey> allowed_counterparty. Legacy (191-byte)
  // claims never wrote this field — the cursor now sits in their guaranteed-
  // zero allocation padding, whose 0x00 reads as the Borsh None tag → null.
  // We never over-read: a Some tag pulls exactly 32 more bytes, which only new
  // (224-byte) claims have. `cursor >= buf.length` (no padding byte at all)
  // cannot occur on a real account of either generation, but decode it as the
  // same "no binding" null rather than throwing on a hypothetical source that
  // trims trailing zeros.
  let allowedCounterparty: string | null = null;
  if (cursor < buf.length) {
    const tag = buf.readUInt8(cursor);
    cursor += 1;
    if (tag === 1) {
      requireBytes(32);
      allowedCounterparty = new PublicKey(buf.subarray(cursor, cursor + 32)).toBase58();
      cursor += 32;
    } else if (tag !== 0) {
      throw new Error(
        `LockedClaim ${address} invalid allowed_counterparty Option tag: ${tag}`,
      );
    }
  }

  return {
    address,
    version,
    bump,
    vault,
    sessionPubkeyAtLock,
    voucherHash,
    amount,
    createdAt,
    maturityAt,
    holderRecoveryAt,
    currentHolder,
    status,
    settledAt,
    recoveredAt,
    allowedCounterparty,
  };
}

/** All LockedClaims for a vault, optionally filtered by status.
 *
 *  Mirrors fetchVaultSessionAccounts EXCEPT it deliberately omits the
 *  `dataSize` gPA filter: LockedClaim is variable-length (the Option<i64>
 *  fields), so a size filter would wrongly drop claims whose Option encoding
 *  differs in length. This is the one place we MUST deviate from the
 *  fixed-size SessionAccount template. */
export async function fetchVaultLockedClaims(
  connection: Connection,
  vaultPda: PublicKey,
  opts?: { status?: LockedClaimStatus },
  programId: PublicKey = DEXTER_VAULT_PROGRAM_ID,
): Promise<LockedClaimState[]> {
  const raw = await connection.getProgramAccounts(programId, {
    commitment: 'confirmed',
    filters: [
      // NO dataSize filter — LockedClaim is variable-length (Option<i64> fields).
      { memcmp: { offset: 0, bytes: LOCKED_CLAIM_DISCRIMINATOR_B58 } },
      { memcmp: { offset: LOCKED_CLAIM_VAULT_OFFSET, bytes: vaultPda.toBase58() } },
    ],
  });
  const claims = raw.map(({ pubkey, account }) =>
    decodeLockedClaim(pubkey.toBase58(), account.data),
  );
  return opts?.status ? claims.filter((c) => c.status === opts.status) : claims;
}
