/**
 * Canonical types for vault state, sessions, and vouchers.
 *
 * This file merges three previously-separate type contracts:
 *  - dexter-api/src/vault/vaultState.types.ts
 *  - dexter-x402-sdk/src/tab/types.ts (the session/voucher half)
 *  - dexter-facilitator/src/vault/vaultReader.ts (the session shape; now the
 *    V6 per-counterparty SessionAccountState below)
 *
 * The on-chain program (dexter-vault v2) is the ultimate referee; these
 * types describe the off-chain mirror of its state.
 */

// ── Vault account state ───────────────────────────────────────────────────

export interface PendingWithdrawal {
  amount: string;          // atomic, u64 stringified (exceeds Number.MAX_SAFE_INTEGER)
  destination: string;     // base58
  requestedAt: number;     // unix seconds
}

export interface VaultOnchainState {
  exists: boolean;
  pendingVoucherCount: number;
  pendingWithdrawal: PendingWithdrawal | null;
}

export interface VaultStateFull {
  exists: boolean;
  version: number;
  swigAddress: string | null;
  dexterAuthority: string | null;
  pendingVoucherCount: number;
  liveSessionCount: number;
}

// ── V6 SessionAccount (per-counterparty session PDA) ─────────────────────

/** Decoded SessionRegistration — field-for-field mirror of the on-chain struct. */
export interface SessionRegistrationState {
  sessionPubkey: Uint8Array;        // 32 bytes, ed25519
  maxAmount: bigint;                // lifetime cap, atomic units
  expiresAt: number;                // unix seconds
  allowedCounterparty: string;      // base58
  nonce: number;
  spent: bigint;                    // cumulative settled (terminal-settle odometer)
  currentOutstanding: bigint;       // live unsettled exposure (the revolving meter)
  maxRevolvingCapacity: bigint;     // admission cap for the revolving meter
  crystallizedCumulative: bigint;   // lock-terminal odometer
  lastLockedSequence: number;       // reserved; NOT the replay guard
}

/** Decoded SessionAccount PDA. `version === 0` = never-touched OR cleared (by
 *  revoke or the register-time expiry sweep) — the authoritative "no live
 *  session" signal. NOT the Anchor discriminator (which is set before the
 *  handler runs and therefore proves nothing about liveness). */
export interface SessionAccountState {
  address: string;                  // base58 PDA
  version: number;                  // 0 | 1
  bump: number;
  vault: string;                    // base58
  session: SessionRegistrationState;
}

// ── Tab status (vault enrollment lifecycle) ──────────────────────────────

export type VaultStatus =
  | 'not_enrolled'
  | 'awaiting_ceremony'
  | 'provisioning'
  | 'ready';

export type VaultStateKey =
  | { kind: 'account'; supabaseUserId: string }
  | { kind: 'handle'; userHandle: Uint8Array }
  | { kind: 'session'; mcpSessionId: string };

export interface VaultStateOnchainExtended {
  vaultExists: boolean;
  pendingVoucherCount: number | null;
  withdrawalBlocked: boolean;
  pendingWithdrawal: PendingWithdrawal | null;
  recovery: { available: boolean; availableAt: number | null; reason: string };
  usdcAtaExists: boolean;
  usdcAtomic: string;
}

export interface VaultState {
  status: VaultStatus;
  vault: {
    vaultPda: string;
    swigAddress: string;
    coolingOffSeconds: number;
    initializedAt: string | Date;
    faucetDrippedAt: string | Date | null;
  } | null;
  credentialId: string | null;
  deviceLabel: string | null;
  enrolledAt: string | Date | null;
  claimedBySupabaseUser: boolean;
  onchain: VaultStateOnchainExtended | null;
}

// ── Tab session-key + voucher types ──────────────────────────────────────

export type TabNetworkId = 'solana:mainnet' | (string & {});
export type AtomicAmount = string;
export type HumanAmount = string;

export interface SessionScope {
  channelId: string;
  maxAmountAtomic: AtomicAmount;
  /** Revolving capacity cap (atomic units) the on-chain meter (current_outstanding)
   *  is checked against. Optional; callers who omit it default to maxAmountAtomic
   *  (revolving cap == total cap). The on-chain program requires > 0. */
  revolvingCapacityAtomic?: AtomicAmount;
  expiresAtUnix: number;
  allowedCounterparty: string;
}

export interface SessionKey {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
  scope: SessionScope;
  registration: Uint8Array;
}

export interface VoucherPayload {
  channelId: string;
  cumulativeAmount: AtomicAmount;
  sequenceNumber: number;
}

export interface SignedVoucher {
  payload: VoucherPayload;
  sessionPublicKey: Uint8Array;
  sessionRegistration: Uint8Array;
  sessionSignature: Uint8Array;
}
