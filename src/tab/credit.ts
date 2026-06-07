/**
 * Credit verbs — the tab that can spend PAST the balance. Each wraps a proven,
 * mainnet-tested credit instruction with the SignV2 transfer, same shape as
 * settleTab. WHOSE-SWIG: draw = FINANCIER funds → seller; repay + seize = USER
 * funds → financier. Returns instructions; does NOT send.
 */
import { Connection, PublicKey, TransactionInstruction } from '@solana/web3.js';
import {
  buildDrawCreditInstruction,
  buildRepayCreditInstruction,
  buildSeizeCollateralInstruction,
} from '../instructions/index.js';
import { defaultAssembleSignV2, type AssembleSignV2 } from './assembleSignV2.js';

export interface DrawCreditParams {
  connection: Connection;
  userVaultPda: PublicKey;
  financierSwig: PublicKey;       // == vault.standby_backer; funds the draw
  amount: bigint;
  recoveryWindowSeconds: bigint;
  dexterAuthority: PublicKey;
  sellerAta: PublicKey;
  feePayer: PublicKey;
  assembleSignV2?: AssembleSignV2;
}

/**
 * The borrow. draw_credit moves funds FINANCIER → seller, so the SignV2 transfer
 * spends the FINANCIER swig. The on-chain draw_credit derives the financier's
 * swig_wallet_address PDA internally (see buildDrawCreditInstruction).
 */
export async function drawCredit(p: DrawCreditParams): Promise<TransactionInstruction[]> {
  const vaultIx = buildDrawCreditInstruction({
    financierSwig: p.financierSwig,
    vaultPda: p.userVaultPda,
    dexterAuthority: p.dexterAuthority,
    amount: p.amount,
    recoveryWindowSeconds: p.recoveryWindowSeconds,
  });
  const assemble = p.assembleSignV2 ?? defaultAssembleSignV2;
  const signV2Ixs = await assemble({
    connection: p.connection,
    swigAddress: p.financierSwig,
    feePayer: p.feePayer,
    vaultIx,
    transfers: [{ destinationAta: p.sellerAta, amount: p.amount }],
  });
  return [vaultIx, ...signV2Ixs];
}

export interface RepayCreditParams {
  connection: Connection;
  userVaultPda: PublicKey;
  userSwig: PublicKey;            // user funds the repayment
  amount: bigint;
  dexterAuthority: PublicKey;
  financierAta: PublicKey;
  feePayer: PublicKey;
  assembleSignV2?: AssembleSignV2;
}

/**
 * The paydown. repay_credit moves funds USER → financier, so the SignV2 transfer
 * spends the USER swig. buildRepayCreditInstruction takes the user swig as
 * `swigAddress` and derives its swig_wallet_address PDA internally.
 */
export async function repayCredit(p: RepayCreditParams): Promise<TransactionInstruction[]> {
  const vaultIx = buildRepayCreditInstruction({
    swigAddress: p.userSwig,
    vaultPda: p.userVaultPda,
    dexterAuthority: p.dexterAuthority,
    amount: p.amount,
  });
  const assemble = p.assembleSignV2 ?? defaultAssembleSignV2;
  const signV2Ixs = await assemble({
    connection: p.connection,
    swigAddress: p.userSwig,
    feePayer: p.feePayer,
    vaultIx,
    transfers: [{ destinationAta: p.financierAta, amount: p.amount }],
  });
  return [vaultIx, ...signV2Ixs];
}

export interface SeizeCollateralParams {
  connection: Connection;
  userVaultPda: PublicKey;
  userSwig: PublicKey;
  dexterAuthority: PublicKey;
  financierAta: PublicKey;
  feePayer: PublicKey;
  seizeAmount: bigint;           // the borrowed amount being seized
  assembleSignV2?: AssembleSignV2;
}

/**
 * The deadline liquidation. seize_collateral moves the borrowed slice USER →
 * financier, so the SignV2 transfer spends the USER swig. The on-chain
 * SeizeCollateralArgs is empty (the contract zeroes vault.borrowed); seizeAmount
 * is used ONLY for the SignV2 transfer leg — the snapshot of what's owed.
 */
export async function seizeCollateral(p: SeizeCollateralParams): Promise<TransactionInstruction[]> {
  const vaultIx = buildSeizeCollateralInstruction({
    swigAddress: p.userSwig,
    vaultPda: p.userVaultPda,
    dexterAuthority: p.dexterAuthority,
  });
  const assemble = p.assembleSignV2 ?? defaultAssembleSignV2;
  const signV2Ixs = await assemble({
    connection: p.connection,
    swigAddress: p.userSwig,
    feePayer: p.feePayer,
    vaultIx,
    transfers: [{ destinationAta: p.financierAta, amount: p.seizeAmount }],
  });
  return [vaultIx, ...signV2Ixs];
}
