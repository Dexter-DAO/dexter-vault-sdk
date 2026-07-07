/**
 * Byte-level fixtures for decodeLockedClaim, hand-built from the Rust layout
 * (programs/dexter-vault/src/state.rs::LockedClaim @ kt1-program-guard-knob
 * ec95012) — NOT from JS re-serialization, so a decoder/encoder that drift
 * together cannot mask a layout break.
 *
 * The K-T1 #77 fork proof, mirrored here from locked_claim_layout_tests:
 *   - legacy claims = 191-byte accounts (8 disc + 183 old INIT_SPACE); their
 *     content ends ≤ offset 183, the rest is GUARANTEED-ZERO allocation
 *     padding, and the tail Option tag read from that padding MUST decode as
 *     None (null) — never a phantom pubkey, never an over-read.
 *   - new claims = 224-byte accounts (8 + 183 + 33) carrying Some(seller).
 */
import { describe, it, expect } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { LOCKED_CLAIM_DISCRIMINATOR } from '../constants/index.js';
import { decodeLockedClaim } from './lockedClaimReader.js';

const LEGACY_ACCOUNT_LEN = 191; // 8 disc + 183 pre-#77 INIT_SPACE
const NEW_ACCOUNT_LEN = 224; // 8 disc + 183 + 33 (Option<Pubkey> tail)

function uniqueKey(): PublicKey {
  return Keypair.generate().publicKey;
}

/** Hand-place the fixed prefix (disc..created_at, offsets 0..122) per the
 *  Rust layout, then return the buffer + a cursor for the variable region. */
function fixedPrefix(
  len: number,
  f: { vault: PublicKey; session: PublicKey; voucher: PublicKey },
): Buffer {
  const buf = Buffer.alloc(len); // zero-filled = the real allocation padding
  Buffer.from(LOCKED_CLAIM_DISCRIMINATOR).copy(buf, 0);
  buf.writeUInt8(1, 8); // version
  buf.writeUInt8(254, 9); // bump
  f.vault.toBuffer().copy(buf, 10);
  f.session.toBuffer().copy(buf, 42);
  f.voucher.toBuffer().copy(buf, 74);
  buf.writeBigUInt64LE(123_456n, 106); // amount
  buf.writeBigInt64LE(1_751_000_000n, 114); // created_at
  return buf;
}

describe('decodeLockedClaim — allowed_counterparty tail (K-T1 #77)', () => {
  it('legacy 191-byte claim (options Some/Some, content ends at 175) → null, no over-read', () => {
    const vault = uniqueKey();
    const session = uniqueKey();
    const voucher = uniqueKey();
    const holder = uniqueKey();
    const buf = fixedPrefix(LEGACY_ACCOUNT_LEN, { vault, session, voucher });
    // Variable region, hand-walked per the Rust field order:
    buf.writeUInt8(1, 122); //         maturity_at tag = Some
    buf.writeBigInt64LE(1_751_000_600n, 123);
    buf.writeUInt8(1, 131); //         holder_recovery_at tag = Some
    buf.writeBigInt64LE(1_751_087_000n, 132);
    holder.toBuffer().copy(buf, 140); // current_holder @140..172
    buf.writeUInt8(0, 172); //         status = Pending
    buf.writeUInt8(0, 173); //         settled_at tag = None
    buf.writeUInt8(0, 174); //         recovered_at tag = None
    // Content ends at 175 — the maximal legacy content. Bytes 175..191 are the
    // zero allocation padding the fork proof leans on: tag@175 = 0x00 → None.

    const c = decodeLockedClaim('LegacyMaxClaim', buf);
    expect(c.allowedCounterparty).toBeNull();
    // The rest of the decode must be untouched by the tail walk:
    expect(c.vault).toBe(vault.toBase58());
    expect(c.sessionPubkeyAtLock).toBe(session.toBase58());
    expect(c.amount).toBe('123456');
    expect(c.createdAt).toBe(1_751_000_000);
    expect(c.maturityAt).toBe(1_751_000_600);
    expect(c.holderRecoveryAt).toBe(1_751_087_000);
    expect(c.currentHolder).toBe(holder.toBase58());
    expect(c.status).toBe('Pending');
    expect(c.settledAt).toBeNull();
    expect(c.recoveredAt).toBeNull();
  });

  it('legacy 191-byte claim (all options None, content ends at 159) → null across 32 padding bytes', () => {
    // Minimal legacy content: the padding run (159..191) is 32 bytes — exactly
    // a pubkey's width. A decoder that misread padding as a key field would
    // fabricate the all-zero pubkey here instead of null.
    const buf = fixedPrefix(LEGACY_ACCOUNT_LEN, {
      vault: uniqueKey(),
      session: uniqueKey(),
      voucher: uniqueKey(),
    });
    buf.writeUInt8(0, 122); // maturity_at = None
    buf.writeUInt8(0, 123); // holder_recovery_at = None
    uniqueKey().toBuffer().copy(buf, 124); // current_holder @124..156
    buf.writeUInt8(0, 156); // status = Pending
    buf.writeUInt8(0, 157); // settled_at = None
    buf.writeUInt8(0, 158); // recovered_at = None

    const c = decodeLockedClaim('LegacyMinClaim', buf);
    expect(c.allowedCounterparty).toBeNull();
    expect(c.maturityAt).toBeNull();
    expect(c.holderRecoveryAt).toBeNull();
    expect(c.status).toBe('Pending');
  });

  it('new 224-byte claim → Some(seed-proven seller) as base58', () => {
    const seller = uniqueKey();
    const holder = uniqueKey();
    const buf = fixedPrefix(NEW_ACCOUNT_LEN, {
      vault: uniqueKey(),
      session: uniqueKey(),
      voucher: uniqueKey(),
    });
    // Different option pattern from the legacy fixture, to prove the tail is
    // reached by cursor-walking (not a fixed offset):
    buf.writeUInt8(0, 122); //         maturity_at = None
    buf.writeUInt8(1, 123); //         holder_recovery_at = Some
    buf.writeBigInt64LE(1_751_090_000n, 124);
    holder.toBuffer().copy(buf, 132); // current_holder @132..164
    buf.writeUInt8(1, 164); //         status = Settled
    buf.writeUInt8(1, 165); //         settled_at = Some
    buf.writeBigInt64LE(1_751_050_000n, 166);
    buf.writeUInt8(0, 174); //         recovered_at = None
    buf.writeUInt8(1, 175); //         allowed_counterparty tag = Some
    seller.toBuffer().copy(buf, 176); // seller @176..208; 208..224 = padding

    const c = decodeLockedClaim('NewBoundClaim', buf);
    expect(c.allowedCounterparty).toBe(seller.toBase58());
    expect(c.holderRecoveryAt).toBe(1_751_090_000);
    expect(c.status).toBe('Settled');
    expect(c.settledAt).toBe(1_751_050_000);
    expect(c.currentHolder).toBe(holder.toBase58());
  });

  it('explicit None tail tag (legacy write-back re-serialization) → null', () => {
    // recover_abandoned_lock's status flip re-serializes a legacy claim under
    // the extended struct: an EXPLICIT 0x00 tag lands where padding was.
    // Indistinguishable from padding by value — pinned anyway.
    const buf = fixedPrefix(LEGACY_ACCOUNT_LEN, {
      vault: uniqueKey(),
      session: uniqueKey(),
      voucher: uniqueKey(),
    });
    buf.writeUInt8(0, 122); // maturity_at = None
    buf.writeUInt8(0, 123); // holder_recovery_at = None
    uniqueKey().toBuffer().copy(buf, 124);
    buf.writeUInt8(2, 156); // status = Abandoned
    buf.writeUInt8(0, 157); // settled_at = None
    buf.writeUInt8(1, 158); // recovered_at = Some
    buf.writeBigInt64LE(1_751_060_000n, 159);
    buf.writeUInt8(0, 167); // allowed_counterparty = explicit None

    const c = decodeLockedClaim('RecoveredLegacyClaim', buf);
    expect(c.allowedCounterparty).toBeNull();
    expect(c.status).toBe('Abandoned');
    expect(c.recoveredAt).toBe(1_751_060_000);
  });

  it('Some tag without 32 pubkey bytes → addressed truncation error, never a partial read', () => {
    // Cannot occur on a real account of either generation (legacy padding is
    // zero; new claims allocate the full 33-byte tail) — this pins the
    // no-over-read guarantee itself.
    const buf = fixedPrefix(191, {
      vault: uniqueKey(),
      session: uniqueKey(),
      voucher: uniqueKey(),
    });
    buf.writeUInt8(0, 122);
    buf.writeUInt8(0, 123);
    uniqueKey().toBuffer().copy(buf, 124);
    buf.writeUInt8(0, 156);
    buf.writeUInt8(0, 157);
    buf.writeUInt8(0, 158);
    buf.writeUInt8(1, 159); // Some tag with only 31 bytes left in the buffer
    expect(() => decodeLockedClaim('TruncatedTail', buf.subarray(0, 191))).toThrow(
      /truncated at offset 160/,
    );
  });

  it('invalid tail tag → throws (mirrors Borsh strictness)', () => {
    const buf = fixedPrefix(LEGACY_ACCOUNT_LEN, {
      vault: uniqueKey(),
      session: uniqueKey(),
      voucher: uniqueKey(),
    });
    buf.writeUInt8(0, 122);
    buf.writeUInt8(0, 123);
    uniqueKey().toBuffer().copy(buf, 124);
    buf.writeUInt8(0, 156);
    buf.writeUInt8(0, 157);
    buf.writeUInt8(0, 158);
    buf.writeUInt8(7, 159); // garbage tag
    expect(() => decodeLockedClaim('BadTagClaim', buf)).toThrow(
      /invalid allowed_counterparty Option tag: 7/,
    );
  });
});
