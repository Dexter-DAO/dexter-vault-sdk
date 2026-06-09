/**
 * migrate_v5_to_v6 — V5 (inline active_session) → V6 (per-counterparty PDAs).
 *
 * TWO instructions, picked by whether the V5 vault carries a LIVE (unexpired)
 * active_session:
 *  - none/expired → buildMigrateV5ToV6Instruction (vault shrinks; freed rent
 *    refunded to payer)
 *  - live → buildMigrateV5ToV6WithSessionInstruction (the live session is
 *    carried out into a NEW session PDA; liveCounterparty MUST equal the
 *    embedded active_session.allowed_counterparty or the handler reverts;
 *    payer funds the PDA rent — up-front, init runs before the handler —
 *    and receives the vault's shrink rent)
 *
 * Picking the wrong builder reverts deterministically: the plain instruction on
 * a vault carrying a live session fails with SessionAlreadyActive, while the
 * with_session instruction fails with NoActiveSession when the vault has no
 * active_session (or SessionExpiryInPast when the session it carries is expired).
 *
 * Both are dexter_authority-gated. SDK 0.8.x cannot DECODE a V5 vault to make
 * the live-vs-none choice (the V5 reader was removed); callers migrating wild
 * V5 vaults decide via their own records. No real V5 consumers exist as of
 * 2026-06-09 — these builders exist for completeness, not a live fleet.
 */
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { DEXTER_VAULT_PROGRAM_ID, DISCRIMINATORS } from '../constants/index.js';
import { deriveSessionPda } from '../session/index.js';

export interface MigrateV5ToV6Params {
  vaultPda: PublicKey;
  dexterAuthority: PublicKey;   // signer
  payer: PublicKey;             // signer, writable — receives the shrink rent
}

export function buildMigrateV5ToV6Instruction(p: MigrateV5ToV6Params): TransactionInstruction {
  return new TransactionInstruction({
    programId: DEXTER_VAULT_PROGRAM_ID,
    keys: [
      { pubkey: p.vaultPda, isSigner: false, isWritable: true },
      { pubkey: p.dexterAuthority, isSigner: true, isWritable: false },
      { pubkey: p.payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(DISCRIMINATORS.migrate_v5_to_v6),
  });
}

export interface MigrateV5ToV6WithSessionParams extends MigrateV5ToV6Params {
  /** Must equal the V5 vault's embedded active_session.allowed_counterparty. */
  liveCounterparty: PublicKey;
}

export function buildMigrateV5ToV6WithSessionInstruction(
  p: MigrateV5ToV6WithSessionParams,
): TransactionInstruction {
  const [sessionPda] = deriveSessionPda(p.vaultPda, p.liveCounterparty);
  return new TransactionInstruction({
    programId: DEXTER_VAULT_PROGRAM_ID,
    keys: [
      { pubkey: p.vaultPda, isSigner: false, isWritable: true },
      { pubkey: p.dexterAuthority, isSigner: true, isWritable: false },
      { pubkey: sessionPda, isSigner: false, isWritable: true },
      { pubkey: p.payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      Buffer.from(DISCRIMINATORS.migrate_v5_to_v6_with_session),
      p.liveCounterparty.toBuffer(),
    ]),
  });
}
