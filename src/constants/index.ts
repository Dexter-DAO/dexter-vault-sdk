/**
 * Canonical on-chain constants. Every program ID, every discriminator.
 * If a value here changes, exactly one test snapshot in tests/byte-parity.test.ts
 * needs to update — that's the gate.
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
