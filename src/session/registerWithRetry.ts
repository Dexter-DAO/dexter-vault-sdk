/**
 * registerSessionWithRetry — the production wrapper around the V6 sibling
 * contract's fetch-vs-execute race.
 *
 * The register gate demands the COMPLETE set of version!=0 sibling
 * SessionAccounts, fetched FRESH (src/session/fetch.ts). A sibling that
 * expires + gets swept between our fetch and our send makes the completeness
 * equation fail (`IncompleteSessionSet`); a malformed order fails
 * `SessionAccountsNotSorted` (6019). A refetch + rebuild cures 6022; 6019 is
 * included defensively (the builder sorts, so it would imply a builder bug a
 * rebuild reproduces — the bounded attempts keep that cheap). Never cured by
 * resending the same bytes. This wrapper owns that loop.
 *
 * Transport stays caller-owned (the injected `send`): the SDK never owns the
 * tx lifecycle — the sponsor signs as payer and has its own fee/confirm
 * policy. The injectable fetch fns are the same testing/production seam
 * waitForSession uses (wait.ts:11-14).
 */
import { Connection, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { buildRegisterSessionKeyInstruction } from '../instructions/registerSession.js';
import { fetchSessionAccount, fetchVaultSessionAccounts, sessionPdasOf } from './fetch.js';
import { isSessionLive } from './decode.js';

/** 6022 = 0x1786 IncompleteSessionSet · 6019 = 0x1783 SessionAccountsNotSorted */
const RETRYABLE = /IncompleteSessionSet|SessionAccountsNotSorted|0x1786|0x1783|\b6022\b|\b6019\b/;

export function isRetryableSessionSetError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return RETRYABLE.test(msg);
}

export interface RegisterSessionWithRetryArgs {
  connection: Connection;
  vaultPda: PublicKey;
  sessionPubkey: Uint8Array;         // 32 bytes, ed25519
  maxAmount: bigint;
  expiresAt: bigint;                 // i64 seconds
  allowedCounterparty: PublicKey;
  nonce: number;                     // u32
  maxRevolvingCapacity: bigint;
  swigAddress: PublicKey;
  /** Vault swig-wallet USDC ATA, or `null` for a credit-only vault with no ATA
   *  (own-USDC counted as 0 on-chain). Resolve via `resolveVaultUsdcAta`. */
  vaultUsdcAta: PublicKey | null;
  payer: PublicKey;
  clientDataJSON: Uint8Array;
  authenticatorData: Uint8Array;
  /**
   * Caller-owned transport: receives [...preInstructions, registerIx], must
   * send + confirm, return the signature, and THROW on failure with the
   * program error text intact (sendRawTransaction/simulate errors qualify).
   */
  send: (instructions: TransactionInstruction[]) => Promise<string>;
  /** Prepended verbatim on every attempt (compute budget, secp256r1 precompile). */
  preInstructions?: TransactionInstruction[];
  /** Total send attempts. Default 3. */
  maxAttempts?: number;
  /** Testing/production seams (default: the real chain readers). */
  fetchSessions?: typeof fetchVaultSessionAccounts;
  fetchSession?: typeof fetchSessionAccount;
}

export interface RegisterSessionWithRetryResult {
  signature: string;
  attempts: number;
  /** True iff a LIVE session existed for this counterparty before the send —
   *  i.e. this register REPLACED it and reset its meters. */
  replaced: boolean;
  /** Sibling count of the LAST (successful) attempt, target excluded. */
  siblingCount: number;
}

export async function registerSessionWithRetry(
  args: RegisterSessionWithRetryArgs,
): Promise<RegisterSessionWithRetryResult> {
  const maxAttempts = args.maxAttempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('registerSessionWithRetry: maxAttempts must be an integer >= 1');
  }
  const fetchSessions = args.fetchSessions ?? fetchVaultSessionAccounts;
  const fetchSession = args.fetchSession ?? fetchSessionAccount;

  // Pre-send replace check: existence is blind to replace; LIVENESS is the signal.
  const existing = await fetchSession(args.connection, args.vaultPda, args.allowedCounterparty);
  const replaced = existing !== null && isSessionLive(existing);

  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    // FRESH siblings immediately before build+send — the whole point.
    const siblings = sessionPdasOf(await fetchSessions(args.connection, args.vaultPda));
    const registerIx = buildRegisterSessionKeyInstruction({
      vaultPda: args.vaultPda,
      sessionPubkey: args.sessionPubkey,
      maxAmount: args.maxAmount,
      expiresAt: args.expiresAt,
      allowedCounterparty: args.allowedCounterparty,
      nonce: args.nonce,
      maxRevolvingCapacity: args.maxRevolvingCapacity,
      swigAddress: args.swigAddress,
      vaultUsdcAta: args.vaultUsdcAta,
      payer: args.payer,
      siblingSessionPdas: siblings,
      clientDataJSON: args.clientDataJSON,
      authenticatorData: args.authenticatorData,
    });
    // builder excludes the target + dedups: sibling metas = keys beyond the 8 fixed accounts
    const siblingCount = registerIx.keys.length - 8;
    try {
      const signature = await args.send([...(args.preInstructions ?? []), registerIx]);
      return { signature, attempts: attempt, replaced, siblingCount };
    } catch (err) {
      lastErr = err;
      if (!isRetryableSessionSetError(err) || attempt === maxAttempts) throw err;
    }
  }
  /* istanbul ignore next -- loop always returns or throws */
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
