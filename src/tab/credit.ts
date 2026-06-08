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
  buildSetStandbyReserveInstruction,
  buildCloseStandbyInstruction,
} from '../instructions/index.js';
import { buildSecp256r1VerifyInstruction } from '../precompile/index.js';
import { defaultAssembleSignV2, type AssembleSignV2 } from './assembleSignV2.js';
import {
  defaultAssembleStandbyReserveSignV2,
  type AssembleStandbyReserveSignV2,
} from './assembleStandbyReserveSignV2.js';

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
 * spends the FINANCIER swig. buildDrawCreditInstruction derives the financier's
 * swig_wallet_address PDA off-chain and passes it as an account; the on-chain
 * program validates it.
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
 * `swigAddress`, derives its swig_wallet_address PDA off-chain and passes it as
 * an account; the on-chain program validates it.
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

// ── set_standby_reserve (financier; mechanism B) ─────────────────────────────

export interface SetStandbyReserveArgs {
  connection: Connection;
  financierSwig: PublicKey;
  feePayer: PublicKey;
  newReserve: bigint;
  /** Financier swig role index holding the Program(dexter_vault) authority.
   *  The financier swig must have this authority registered (a one-time setup;
   *  see docs). */
  programRoleId: number;
  assembleStandbyReserveSignV2?: AssembleStandbyReserveSignV2;
}

/**
 * Set/raise the financier's committed reserve. MECHANISM B: the vault ix runs as
 * the INNER CPI of the financier swig's SignV2 (the swig_wallet signs it). UNLIKE
 * drawCredit, this returns ONLY the SignV2 ixs — the vault ix is the inner CPI,
 * not a separate top-level instruction. Returns instructions; does NOT send.
 */
export async function setStandbyReserve(p: SetStandbyReserveArgs): Promise<TransactionInstruction[]> {
  const vaultIx = buildSetStandbyReserveInstruction({
    financierSwig: p.financierSwig,
    feePayer: p.feePayer,
    newReserve: p.newReserve,
  });
  const assemble = p.assembleStandbyReserveSignV2 ?? defaultAssembleStandbyReserveSignV2;
  return assemble({
    connection: p.connection,
    financierSwig: p.financierSwig,
    feePayer: p.feePayer,
    vaultIx,
    programRoleId: p.programRoleId,
  });
}

// ── close_standby (both legs) ────────────────────────────────────────────────

export interface CloseStandbyArgs {
  connection: Connection;
  vaultPda: PublicKey;
  financierSwig: PublicKey;
  feePayer: PublicKey;
  closer: 'user' | 'financier';
  /** FINANCIER leg only: the swig role index holding Program(dexter_vault). */
  programRoleId?: number;
  /** USER leg only: the pre-signed passkey artifacts over buildCloseStandbyMessage. */
  userPasskey?: {
    publicKey: Uint8Array;       // 33-byte compressed P-256
    signature: Uint8Array;       // 64-byte
    /** The exact bytes the passkey signed. MUST equal
     *  buildPrecompileMessage(clientDataJSON, authenticatorData) (= authenticatorData
     *  || SHA-256(clientDataJSON)); a mismatch silently fails on-chain verification. */
    precompileMessage: Uint8Array;
    clientDataJSON: Uint8Array;
    authenticatorData: Uint8Array;
  };
  assembleStandbyReserveSignV2?: AssembleStandbyReserveSignV2;
}

/**
 * Close a standby. FINANCIER leg = mechanism B (vault ix is the SignV2 inner CPI;
 * returns ONLY the SignV2 ixs). USER leg = a [secp256r1 precompile, close_standby{user}]
 * pair (the precompile MUST immediately precede the close ix; the handler reads
 * instructions_sysvar at current_index-1). Returns instructions; does NOT send.
 */
export async function closeStandby(p: CloseStandbyArgs): Promise<TransactionInstruction[]> {
  if (p.closer === 'user') {
    if (!p.userPasskey) throw new Error('closeStandby user leg requires userPasskey');
    const precompileIx = buildSecp256r1VerifyInstruction(
      p.userPasskey.publicKey,
      p.userPasskey.signature,
      p.userPasskey.precompileMessage,
    );
    const closeIx = buildCloseStandbyInstruction({
      closer: 'user',
      vaultPda: p.vaultPda,
      financierSwig: p.financierSwig,
      clientDataJSON: p.userPasskey.clientDataJSON,
      authenticatorData: p.userPasskey.authenticatorData,
    });
    return [precompileIx, closeIx];   // precompile immediately precedes the vault ix
  }
  // financier leg
  if (p.programRoleId === undefined) throw new Error('closeStandby financier leg requires programRoleId');
  const vaultIx = buildCloseStandbyInstruction({
    closer: 'financier',
    vaultPda: p.vaultPda,
    financierSwig: p.financierSwig,
    clientDataJSON: new Uint8Array(),     // financier leg: handler ignores these
    authenticatorData: new Uint8Array(),
  });
  const assemble = p.assembleStandbyReserveSignV2 ?? defaultAssembleStandbyReserveSignV2;
  return assemble({
    connection: p.connection,
    financierSwig: p.financierSwig,
    feePayer: p.feePayer,
    vaultIx,
    programRoleId: p.programRoleId,
  });
}
