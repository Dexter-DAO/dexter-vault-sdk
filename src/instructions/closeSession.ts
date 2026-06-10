/**
 * close_session — reclaim the rent parked in a CLEARED session PDA (V6).
 *
 * revoke_session_key / the register-time expiry sweep CLEAR a session
 * (version + every SessionRegistration field zeroed) but never close it
 * (CLEAR-not-CLOSE: same-instruction close opens the sealevel revival
 * window). This is the deferred janitor half: pure rent reclamation.
 *
 * Gates enforced ON-CHAIN (close_session.rs):
 *   - vault.version == V6
 *   - vault.dexter_authority signs AND receives the rent (`close = dexter_authority`)
 *   - session.version == 0 (`SessionStillLive` otherwise — revoke first)
 *
 * Accounts (declaration order — Anchor is strict):
 *   0. [readonly]          vault            — version + has_one authority gate
 *   1. [writable]          session          — CLEARED PDA [b"session", vault, allowed_counterparty];
 *                                             the account body's counterparty is zeroed on a cleared
 *                                             session, so the PDA SEEDS are the only binding — hence
 *                                             allowed_counterparty travels in the args.
 *   2. [signer, writable]  dexter_authority — receives the reclaimed rent
 *
 * Args (Borsh after the 8-byte discriminator):
 *   allowed_counterparty: Pubkey (32 bytes)
 */
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { DEXTER_VAULT_PROGRAM_ID, DISCRIMINATORS } from '../constants/index.js';
import { deriveSessionPda } from '../session/derive.js';

export interface BuildCloseSessionArgs {
  vaultPda: PublicKey;
  /** Names the cleared session PDA (PDA seed AND Borsh arg). */
  allowedCounterparty: PublicKey;
  /** Must equal vault.dexter_authority; signs and receives the rent. */
  dexterAuthority: PublicKey;
}

export function buildCloseSessionInstruction(args: BuildCloseSessionArgs): TransactionInstruction {
  const data = new Uint8Array(40);
  data.set(DISCRIMINATORS.close_session, 0);
  data.set(args.allowedCounterparty.toBytes(), 8);

  const [sessionPda] = deriveSessionPda(args.vaultPda, args.allowedCounterparty);

  return new TransactionInstruction({
    keys: [
      { pubkey: args.vaultPda, isSigner: false, isWritable: false },
      { pubkey: sessionPda, isSigner: false, isWritable: true },
      { pubkey: args.dexterAuthority, isSigner: true, isWritable: true },
    ],
    programId: DEXTER_VAULT_PROGRAM_ID,
    data: Buffer.from(data),
  });
}
