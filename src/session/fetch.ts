/**
 * Sibling discovery + sibling-meta construction for the V6 register gate.
 *
 * THE CONTRACT (programs/dexter-vault/src/instructions/register_session_key.rs,
 * handler step C — get this exactly right or the register REVERTS):
 *  - remaining_accounts must contain EVERY OTHER SessionAccount of this vault
 *    whose version != 0 (live AND expired-unswept), excluding the target.
 *    Cleared accounts (version == 0) must NOT be passed (they're not counted
 *    by live_session_count → completeness would fail).
 *  - STRICT ASCENDING by raw 32-byte pubkey (the gate checks `>` per step).
 *  - ALL passed as writable. The program only REQUIRES writability on expired
 *    siblings (the sweep persists a clear), but a sibling that is live at
 *    fetch time can expire before the tx executes — all-writable removes that
 *    race for the cost of extra write locks on program-owned PDAs.
 *  - Fetch FRESH immediately before building + sending: the gate sweeps expired
 *    siblings (decrementing live_session_count), so a stale list double-counts
 *    a since-swept sibling and fails the completeness equation.
 */
import { Connection, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import {
  DEXTER_VAULT_PROGRAM_ID,
  SESSION_ACCOUNT_DISCRIMINATOR,
  SESSION_ACCOUNT_SIZE,
} from '../constants/index.js';
import { decodeSessionAccount } from './decode.js';
import { deriveSessionPda } from './derive.js';
import type { SessionAccountState } from '../types.js';

/** Fetch one session PDA for (vault, counterparty). null = account absent.
 *  An account with version === 0 is returned as-is — callers decide liveness
 *  via isSessionLive (absent and cleared mean the same thing to the program). */
export async function fetchSessionAccount(
  connection: Connection,
  vault: PublicKey,
  allowedCounterparty: PublicKey,
  programId: PublicKey = DEXTER_VAULT_PROGRAM_ID,
): Promise<SessionAccountState | null> {
  const [pda] = deriveSessionPda(vault, allowedCounterparty, programId);
  const info = await connection.getAccountInfo(pda, 'confirmed');
  if (!info) return null;
  return decodeSessionAccount(pda, info.data);
}

/** All version != 0 SessionAccounts for a vault (live + expired-unswept) — the
 *  exact population the register gate's completeness equation counts. */
export async function fetchVaultSessionAccounts(
  connection: Connection,
  vault: PublicKey,
  programId: PublicKey = DEXTER_VAULT_PROGRAM_ID,
): Promise<SessionAccountState[]> {
  const raw = await connection.getProgramAccounts(programId, {
    commitment: 'confirmed',
    filters: [
      { dataSize: SESSION_ACCOUNT_SIZE },
      { memcmp: { offset: 0, bytes: bs58.encode(SESSION_ACCOUNT_DISCRIMINATOR) } },
      { memcmp: { offset: 10, bytes: vault.toBase58() } },
    ],
  });
  return raw
    .map(({ pubkey, account }) => decodeSessionAccount(pubkey, account.data))
    .filter((s) => s.version !== 0);
}

/** Sibling AccountMeta[] for the register gate: target excluded, deduped,
 *  strict-ascending raw-byte order (== Rust Pubkey Ord), ALL writable. */
export function buildSiblingAccountMetas(
  siblingPdas: PublicKey[],
  targetSessionPda: PublicKey,
): { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] {
  const seen = new Set<string>();
  const unique: PublicKey[] = [];
  for (const k of siblingPdas) {
    const b58 = k.toBase58();
    if (k.equals(targetSessionPda) || seen.has(b58)) continue;
    seen.add(b58);
    unique.push(k);
  }
  unique.sort((a, b) => Buffer.compare(a.toBuffer(), b.toBuffer()));
  return unique.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true }));
}
