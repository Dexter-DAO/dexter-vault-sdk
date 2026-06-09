/**
 * Session PDA derivation — V6 per-counterparty SessionAccount.
 * On-chain seeds (programs/dexter-vault/src/constants.rs + register_session_key.rs):
 *   [b"session", vault, allowed_counterparty]
 * One session per (vault, counterparty); re-register REPLACES in place.
 */
import { PublicKey } from '@solana/web3.js';
import { DEXTER_VAULT_PROGRAM_ID, SESSION_SEED } from '../constants/index.js';

export function deriveSessionPda(
  vault: PublicKey,
  allowedCounterparty: PublicKey,
  programId: PublicKey = DEXTER_VAULT_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SESSION_SEED, vault.toBuffer(), allowedCounterparty.toBuffer()],
    programId,
  );
}
