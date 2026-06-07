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
import { readVaultFull } from '../reader/index.js';
import type { Ed25519Signer } from '../signers/types.js';
import { defaultAssembleSignV2, type AssembleSignV2 } from './assembleSignV2.js';

export interface SettleTabParams {
  connection: Connection;
  vaultPda: PublicKey;
  swigAddress: PublicKey;        // the USER's swig — funds the tab payment
  channelId: Uint8Array;         // 32 bytes
  cumulativeAmount: bigint;
  sequenceNumber: number;        // u32
  sessionSigner: Ed25519Signer;
  sellerAta: PublicKey;
  feePayer: PublicKey;
  /** Must equal the vault's recorded dexter_authority; the settle_tab_voucher signer. */
  dexterAuthority: PublicKey;
  assembleSignV2?: AssembleSignV2;
  readPriorSpent?: (connection: Connection, vaultPda: PublicKey) => Promise<bigint>;
}

const defaultReadPriorSpent = async (
  connection: Connection,
  vaultPda: PublicKey,
): Promise<bigint> => {
  const vault = await readVaultFull(connection, vaultPda);
  const session = vault.activeSession;
  if (!session) throw new Error('settleTab: no active session on vault');
  return session.spent; // VERIFIED native bigint, no .toString()
};

export async function settleTab(p: SettleTabParams): Promise<TransactionInstruction[]> {
  const readPrior = p.readPriorSpent ?? defaultReadPriorSpent;
  const priorSpent = await readPrior(p.connection, p.vaultPda);

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
    channelId: p.channelId,
    cumulativeAmount: p.cumulativeAmount,
    sequenceNumber: p.sequenceNumber,
  });

  // [3/3] Swig SignV2 transfer of the delta (vaultIx becomes the preInstruction).
  const assemble = p.assembleSignV2 ?? defaultAssembleSignV2;
  const signV2Ixs = await assemble({
    connection: p.connection,
    swigAddress: p.swigAddress,
    feePayer: p.feePayer,
    vaultIx,
    transfers: [{ destinationAta: p.sellerAta, amount: delta }],
  });

  return [precompileIx, vaultIx, ...signV2Ixs];
}
