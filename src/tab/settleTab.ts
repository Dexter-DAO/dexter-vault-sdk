/**
 * settleTab — the central ./tab verb. Composes the atomic 3-instruction tab
 * settle: [Ed25519 precompile over the voucher] + [settle_tab_voucher] +
 * [Swig SignV2 transfer of the delta]. The delta (cumulative - priorSpent) is
 * computed from a FRESH on-chain read done INSIDE this verb. On-chain
 * settle_tab_voucher re-validates monotonicity, so a stale read fails safe.
 * Returns instructions; does NOT send. Promoted from dexter-facilitator tabSettle.ts.
 */
import { Connection, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { voucherPayloadMessage } from '../messages/index.js';
import { buildEd25519VerifyInstruction } from '../precompile/index.js';
import { buildSettleTabVoucherInstruction } from '../instructions/index.js';
import { fetchSessionAccount } from '../session/index.js';
import type { Ed25519Signer } from '../signers/types.js';
import { defaultAssembleSignV2, type AssembleSignV2 } from './assembleSignV2.js';

export interface SettleTabParams {
  connection: Connection;
  vaultPda: PublicKey;
  swigAddress: PublicKey;        // the USER's swig — funds the tab payment
  /** V6: the seller this tab pays — names the session PDA. */
  allowedCounterparty: PublicKey;
  channelId: Uint8Array;         // 32 bytes
  cumulativeAmount: bigint;
  sequenceNumber: number;        // u32
  sessionSigner: Ed25519Signer;
  sellerAta: PublicKey;
  feePayer: PublicKey;
  /** Must equal the vault's recorded dexter_authority; the settle_tab_voucher signer. */
  dexterAuthority: PublicKey;
  assembleSignV2?: AssembleSignV2;
  readPriorSpent?: (
    connection: Connection,
    vaultPda: PublicKey,
    allowedCounterparty: PublicKey,
  ) => Promise<bigint>;
}

const defaultReadPriorSpent = async (
  connection: Connection,
  vaultPda: PublicKey,
  allowedCounterparty: PublicKey,
): Promise<bigint> => {
  const s = await fetchSessionAccount(connection, vaultPda, allowedCounterparty);
  // version !== 0 only (NOT isSessionLive): an expired-but-unswept session
  // still carries the true spent odometer — the on-chain ix referees expiry.
  if (!s || s.version === 0) {
    throw new Error(
      `settleTab: no session record (absent or cleared) for counterparty ${allowedCounterparty.toBase58()} on vault ${vaultPda.toBase58()}`,
    );
  }
  return s.session.spent; // VERIFIED native bigint, no .toString()
};

export async function settleTab(p: SettleTabParams): Promise<TransactionInstruction[]> {
  const readPrior = p.readPriorSpent ?? defaultReadPriorSpent;
  const priorSpent = await readPrior(p.connection, p.vaultPda, p.allowedCounterparty);

  if (p.cumulativeAmount <= priorSpent) {
    throw new Error(
      `settleTab: non-monotonic cumulative — ${p.cumulativeAmount} <= prior spent ${priorSpent}`,
    );
  }
  const delta = p.cumulativeAmount - priorSpent;

  // [1/3] Ed25519 precompile over the canonical 44-byte voucher.
  const message = voucherPayloadMessage({
    channelId: p.channelId,
    cumulativeAmount: p.cumulativeAmount,
    sequenceNumber: p.sequenceNumber,
  });
  const signature = await p.sessionSigner.sign(message);
  const precompileIx = buildEd25519VerifyInstruction(
    p.sessionSigner.publicKey,
    signature,
    message,
  );

  // [2/3] settle_tab_voucher vault ix — re-validates monotonicity on-chain.
  const vaultIx = buildSettleTabVoucherInstruction({
    vaultPda: p.vaultPda,
    swigAddress: p.swigAddress,
    dexterAuthority: p.dexterAuthority,
    allowedCounterparty: p.allowedCounterparty,
    channelId: p.channelId,
    cumulativeAmount: p.cumulativeAmount,
    sequenceNumber: p.sequenceNumber,
  });

  // [3/3] Swig SignV2 transfer of the delta. CONTRACT: the assembler's returned
  // list INCLUDES vaultIx — @swig-wallet/kit's getSignInstructions returns the
  // preInstructions AND the SignV2 in one ordered array (see dexter-vault
  // tests/helpers/settle.ts, proven on mainnet). Re-adding vaultIx here would
  // execute settle_tab_voucher TWICE in one tx; the second replays the same
  // cumulative and reverts with LockRangeAlreadyClaimed (caught live 2026-06-09).
  const assemble = p.assembleSignV2 ?? defaultAssembleSignV2;
  const signV2Ixs = await assemble({
    connection: p.connection,
    swigAddress: p.swigAddress,
    feePayer: p.feePayer,
    vaultIx,
    transfers: [{ destinationAta: p.sellerAta, amount: delta }],
  });

  return [precompileIx, ...signV2Ixs];
}
