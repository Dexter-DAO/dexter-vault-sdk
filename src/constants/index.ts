/**
 * Canonical on-chain constants. Every program ID, every discriminator.
 * If a value here changes, a test snapshot in tests/byte-parity.test.ts or
 * tests/v6.byte-parity.test.ts needs to update — those are the gates.
 */

import { PublicKey } from '@solana/web3.js';

// ── Program IDs ───────────────────────────────────────────────────────────

export const DEXTER_VAULT_PROGRAM_ID = new PublicKey(
  'Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc',
);

export const SWIG_PROGRAM_ID = new PublicKey(
  'swigypWHEksbC64pWKwah1WTeh9JXwx8H1rJHLdbQMB',
);

export const SECP256R1_PROGRAM_ID = new PublicKey(
  'Secp256r1SigVerify1111111111111111111111111',
);

export const ED25519_PROGRAM_ID = new PublicKey(
  'Ed25519SigVerify111111111111111111111111111',
);

export const INSTRUCTIONS_SYSVAR_ID = new PublicKey(
  'Sysvar1nstructions1111111111111111111111111',
);

// ── Tokens ────────────────────────────────────────────────────────────────

export const USDC_MAINNET = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDC_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

// ── Vault account layout (v2) ─────────────────────────────────────────────

export const VAULT_SEED_PREFIX = Buffer.from('vault');

// LockedClaim PDA seed — matches programs/dexter-vault/src/state.rs (b"locked-claim").
export const LOCKED_CLAIM_SEED = Buffer.from('locked-claim');

// Anchor account discriminator for LockedClaim (from target/idl/dexter_vault.json).
// Used as the gPA memcmp filter at offset 0.
export const LOCKED_CLAIM_DISCRIMINATOR = Uint8Array.from([146, 227, 254, 205, 9, 82, 6, 245]);

// Precomputed base58 of LOCKED_CLAIM_DISCRIMINATOR — the gPA memcmp filter value
// (same no-runtime-bs58-import rationale as SESSION_ACCOUNT_DISCRIMINATOR_B58).
// A unit test pins this against bs58.encode(LOCKED_CLAIM_DISCRIMINATOR).
export const LOCKED_CLAIM_DISCRIMINATOR_B58 = 'Ra2KzfH1LnQ';

// Byte offset of the `vault` field inside LockedClaim (8 disc + version u8 + bump u8).
// The gPA memcmp filter keys on this; full layout map lives in src/reader/lockedClaimReader.ts.
// NOTE: LockedClaim is VARIABLE-LENGTH (Option<i64> fields), so there is no
// fixed size constant and no dataSize gPA filter — see lockedClaimReader.ts.
export const LOCKED_CLAIM_VAULT_OFFSET = 10;

// ── Credit-identity accounts (CreditRoot / CreditEvent) ───────────────────
// Anchor account discriminators: sha256("account:<Name>")[..8]. Used as gPA
// memcmp filters at offset 0. b58 strings are precomputed (no runtime bs58
// import in the fetch path) and pinned by a unit test against bs58.encode(...).
export const CREDIT_ROOT_DISCRIMINATOR = Uint8Array.from([221, 14, 171, 10, 71, 90, 71, 61]);
export const CREDIT_ROOT_DISCRIMINATOR_B58 = 'dyXtycev4kU';
export const CREDIT_EVENT_DISCRIMINATOR = Uint8Array.from([199, 31, 108, 139, 172, 102, 124, 77]);
export const CREDIT_EVENT_DISCRIMINATOR_B58 = 'aJjvifZcCu2';

// Byte offset of the `nullifier` field inside CreditEvent (8 disc + version u8 + bump u8).
export const CREDIT_EVENT_NULLIFIER_OFFSET = 10; // 8 disc + 1 version + 1 bump

// PDA seeds for CreditRoot / CreditEvent.
export const CREDIT_ROOT_SEED = 'credit_root';
export const CREDIT_EVENT_SEED = 'credit_event';

// Total account sizes (8 disc + INIT_SPACE). gPA dataSize filters.
export const CREDIT_ROOT_SIZE = 58;   // 8+1+1+32+8+8
export const CREDIT_EVENT_SIZE = 99;  // 8+1+1+32+8+32+8+1+8

// ── Session accounts (V6) ─────────────────────────────────────────────────

// Session PDA seed — matches programs/dexter-vault/src/constants.rs (b"session").
// PDA: [SESSION_SEED, vault, allowed_counterparty]. One per (vault, counterparty);
// re-register REPLACES in place (same seed).
export const SESSION_SEED = Buffer.from('session');

// Anchor account discriminator for SessionAccount (sha256("account:SessionAccount")[..8],
// cross-checked against the V6 IDL). Used as the gPA memcmp filter at offset 0.
export const SESSION_ACCOUNT_DISCRIMINATOR = Uint8Array.from([74, 34, 65, 133, 96, 163, 80, 69]);

// Total SessionAccount size: 8 (discriminator) + 154 (INIT_SPACE). gPA dataSize filter.
export const SESSION_ACCOUNT_SIZE = 162;

// Precomputed base58 of SESSION_ACCOUNT_DISCRIMINATOR — the gPA memcmp filter
// value. Hardcoded so the fetch path needs NO runtime bs58 import (the naive
// `import bs58 from 'bs58'` default-import breaks in the emitted .cjs bundle —
// the mainnet proof run of 2026-06-09 caught exactly that). A unit test pins
// this string against bs58.encode(SESSION_ACCOUNT_DISCRIMINATOR).
export const SESSION_ACCOUNT_DISCRIMINATOR_B58 = 'DQC4ziybBxx';

// Byte offset of the `vault` field inside SessionAccount (8 disc + version u8 + bump u8).
// The gPA memcmp filter keys on this; the full layout map lives in src/session/decode.ts.
export const SESSION_VAULT_OFFSET = 10;

// ── Anchor discriminators (8 bytes each, locked) ──────────────────────────
// sha256("global:<ix_name>")[..8]. Cross-checked against IDL.

export const DISCRIMINATORS = Object.freeze({
  initialize_vault:        Uint8Array.from([48, 191, 163, 44, 71, 129, 63, 164]),
  set_swig:                Uint8Array.from([253, 229, 89, 206, 192, 118, 137, 165]),
  settle_voucher:          Uint8Array.from([144, 176, 128, 220, 156, 79, 41, 54]),
  request_withdrawal:      Uint8Array.from([251, 85, 121, 205, 56, 201, 12, 177]),
  finalize_withdrawal:     Uint8Array.from([178, 87, 206, 68, 201, 186, 164, 232]),
  force_release:           Uint8Array.from([122, 190, 243, 252, 54, 202, 208, 234]),
  rotate_passkey:          Uint8Array.from([28, 134, 49, 89, 196, 34, 58, 174]),
  rotate_dexter_authority: Uint8Array.from([145, 60, 4, 119, 180, 205, 236, 134]),
  prove_passkey:           Uint8Array.from([35, 175, 41, 143, 201, 118, 49, 184]),
  settle_tab_voucher:      Uint8Array.from([173, 22, 98, 31, 110, 129, 59, 161]),
  register_session_key:    Uint8Array.from([69, 94, 60, 44, 49, 199, 183, 233]),
  revoke_session_key:      Uint8Array.from([81, 192, 32, 110, 104, 116, 144, 151]),
  lock_voucher:            Uint8Array.from([91, 138, 5, 227, 119, 239, 48, 254]),
  settle_locked_voucher:   Uint8Array.from([44, 80, 216, 43, 247, 253, 101, 45]),
  transfer_lock_ownership: Uint8Array.from([193, 13, 131, 134, 95, 25, 229, 157]),
  recover_abandoned_lock:  Uint8Array.from([169, 213, 107, 64, 229, 49, 43, 234]),
  open_standby:            Uint8Array.from([234, 184, 232, 135, 246, 191, 90, 250]),
  draw_credit:             Uint8Array.from([20, 84, 47, 211, 78, 117, 195, 210]),
  set_standby_reserve:     Uint8Array.from([198, 227, 172, 10, 133, 119, 213, 7]),
  close_standby:           Uint8Array.from([218, 35, 75, 51, 72, 244, 20, 108]),
  repay_credit:            Uint8Array.from([38, 113, 240, 182, 109, 179, 154, 245]),
  seize_collateral:        Uint8Array.from([40, 250, 7, 243, 168, 184, 116, 154]),
  migrate_v4_to_v5:        Uint8Array.from([226, 105, 140, 184, 101, 39, 235, 116]),
  migrate_v5_to_v6:        Uint8Array.from([25, 38, 151, 206, 59, 103, 141, 175]),
  migrate_v5_to_v6_with_session: Uint8Array.from([225, 119, 165, 163, 251, 174, 42, 15]),
  close_session:           Uint8Array.from([68, 114, 178, 140, 222, 38, 248, 211]),
  close_locked_claim:      Uint8Array.from([231, 142, 174, 161, 156, 183, 26, 60]),
  establish_credit_root:   Uint8Array.from([182, 245, 97, 77, 108, 145, 37, 247]),
  record_credit_event:     Uint8Array.from([192, 207, 202, 39, 125, 52, 240, 255]),
});

// ── Domain separators (32 bytes each, NUL-padded) ────────────────────────

export const OTS_SESSION_REGISTER_V1_DOMAIN: Uint8Array = (() => {
  const buf = new Uint8Array(32);
  buf.set(new TextEncoder().encode('OTS_SESSION_REGISTER_V1'), 0);
  return buf;
})();

export const OTS_SESSION_REGISTER_V2_DOMAIN: Uint8Array = (() => {
  const buf = new Uint8Array(32);
  buf.set(new TextEncoder().encode('OTS_SESSION_REGISTER_V2'), 0);
  return buf;
})();

export const OTS_SESSION_REVOKE_V1_DOMAIN: Uint8Array = (() => {
  const buf = new Uint8Array(32);
  buf.set(new TextEncoder().encode('OTS_SESSION_REVOKE_V1'), 0);
  return buf;
})();
