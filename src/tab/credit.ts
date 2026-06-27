/**
 * Credit verbs — the tab that can spend PAST the balance. Each wraps a proven,
 * mainnet-tested credit instruction with the SignV2 transfer, same shape as
 * settleTab. WHOSE-SWIG: draw = FINANCIER funds → seller; repay + seize = USER
 * funds → financier. Returns instructions; does NOT send.
 */
import {
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
  type SimulatedTransactionResponse,
} from '@solana/web3.js';
import {
  buildDrawCreditInstruction,
  buildRepayCreditInstruction,
  buildSeizeCollateralInstruction,
  buildSeizeAncestorInstruction,
  buildCreateNodeInstruction,
  buildEmancipateInstruction,
  buildSetFreezeInstruction,
  buildSetStandbyReserveInstruction,
  buildCloseStandbyInstruction,
  type RateCapInput,
} from '../instructions/index.js';
import { buildSecp256r1VerifyInstruction } from '../precompile/index.js';
import { readVaultFull, walkAncestors, readPrincipalNode } from '../reader/index.js';
import { DEXTER_VAULT_PROGRAM_ID } from '../constants/index.js';
import { defaultAssembleSignV2, type AssembleSignV2 } from './assembleSignV2.js';
import {
  defaultAssembleStandbyReserveSignV2,
  type AssembleStandbyReserveSignV2,
} from './assembleStandbyReserveSignV2.js';

/**
 * Resolve a vault's drawing node and its authenticated ancestor chain in ONE
 * place. Returns `{ drawingNode, chain }` where `chain` is the ancestor list
 * (child→parent, EXCLUDING the leaf) — exactly the program's remaining_accounts.
 * Every credit verb routes through here so chain assembly never forks
 * (anti-bypass-drift, global CLAUDE.md).
 */
export async function resolveDrawChain(
  connection: Connection,
  userVaultPda: PublicKey,
): Promise<{ drawingNode: PublicKey; chain: PublicKey[] }> {
  const vault = await readVaultFull(connection, userVaultPda);
  if (!vault.node) throw new Error(`vault ${userVaultPda.toBase58()} has no welded node`);
  const drawingNode = new PublicKey(vault.node);
  const path = await walkAncestors(connection, drawingNode);
  return { drawingNode, chain: path.slice(1) }; // slice off the leaf
}

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
  const { drawingNode, chain } = await resolveDrawChain(p.connection, p.userVaultPda);
  const vaultIx = buildDrawCreditInstruction({
    financierSwig: p.financierSwig,
    vaultPda: p.userVaultPda,
    drawingNode,
    sellerDestination: p.sellerAta,
    dexterAuthority: p.dexterAuthority,
    amount: p.amount,
    recoveryWindowSeconds: p.recoveryWindowSeconds,
    chain,
  });
  const assemble = p.assembleSignV2 ?? defaultAssembleSignV2;
  const signV2Ixs = await assemble({
    connection: p.connection,
    swigAddress: p.financierSwig,
    feePayer: p.feePayer,
    vaultIx,
    transfers: [{ destinationAta: p.sellerAta, amount: p.amount }],
  });
  // CONTRACT: signV2Ixs INCLUDES vaultIx — @swig-wallet/kit's getSignInstructions
  // returns its preInstructions AND the SignV2 in one ordered array (see
  // assembleSignV2.ts). Re-adding vaultIx here would run draw_credit TWICE in one
  // tx; the second reverts (same double-include class fixed for settleTab/
  // instantPayout in 5d54497).
  return [...signV2Ixs];
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
  const { drawingNode, chain } = await resolveDrawChain(p.connection, p.userVaultPda);
  const vaultIx = buildRepayCreditInstruction({
    swigAddress: p.userSwig,
    vaultPda: p.userVaultPda,
    drawingNode,
    dexterAuthority: p.dexterAuthority,
    amount: p.amount,
    chain,
  });
  const assemble = p.assembleSignV2 ?? defaultAssembleSignV2;
  const signV2Ixs = await assemble({
    connection: p.connection,
    swigAddress: p.userSwig,
    feePayer: p.feePayer,
    vaultIx,
    transfers: [{ destinationAta: p.financierAta, amount: p.amount }],
  });
  // CONTRACT: signV2Ixs INCLUDES vaultIx (see drawCredit / assembleSignV2.ts).
  // Re-adding vaultIx would run repay_credit TWICE and revert.
  return [...signV2Ixs];
}

export interface SeizeCollateralParams {
  connection: Connection;
  userVaultPda: PublicKey;
  userSwig: PublicKey;
  /** The user swig's collateral ATA (owner == swig_wallet_address). */
  collateralAta: PublicKey;
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
  const { drawingNode, chain } = await resolveDrawChain(p.connection, p.userVaultPda);
  const vaultIx = buildSeizeCollateralInstruction({
    swigAddress: p.userSwig,
    vaultPda: p.userVaultPda,
    drawingNode,
    collateralAta: p.collateralAta,
    dexterAuthority: p.dexterAuthority,
    chain,
  });
  const assemble = p.assembleSignV2 ?? defaultAssembleSignV2;
  const signV2Ixs = await assemble({
    connection: p.connection,
    swigAddress: p.userSwig,
    feePayer: p.feePayer,
    vaultIx,
    transfers: [{ destinationAta: p.financierAta, amount: p.seizeAmount }],
  });
  // CONTRACT: signV2Ixs INCLUDES vaultIx (see drawCredit / assembleSignV2.ts).
  // Re-adding vaultIx would run seize_collateral TWICE and revert.
  return [...signV2Ixs];
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

// ── GraphClient facade ───────────────────────────────────────────────────────
// The ONE place graph chain-assembly + account ordering lives. Every consumer
// (the facilitator, Task 14) routes through this — no parallel chain logic
// (anti-bypass-drift, global CLAUDE.md). Draw/repay/seize resolve the drawing
// node + ancestor chain via resolveDrawChain; the cascade walks ancestors here.

export interface GraphCreateNodeParams {
  nodeId: Uint8Array;
  controller: PublicKey;
  payer: PublicKey;
  cap: RateCapInput;
  parentNode?: PublicKey;
  parentController?: PublicKey;
}

export interface GraphFreezeParams {
  targetNode: PublicKey;
  ancestorNode: PublicKey;
  ancestorController: PublicKey;
  frozen: boolean;
}

export interface GraphEmancipateParams {
  node: PublicKey;
  parentNode: PublicKey;
  parentController: PublicKey;
  nodeController: PublicKey;
  creditRoot?: PublicKey;
  newNullifier?: Uint8Array;
}

export interface SimulateDrawParams extends DrawCreditParams {
  /** Optional per-root ALT(s) so a deep chain fits a v0 tx (see altManager). */
  lookupTables?: AddressLookupTableAccount[];
}

/** One ancestor's leg in a RUNG-3 cascade. */
export interface CascadeStep {
  ancestorNode: PublicKey;
  amount: bigint;
  instructions: TransactionInstruction[];
}

export interface CascadeSeizeParams {
  defaultedNode: PublicKey;
  dexterAuthority: PublicKey;
  feePayer: PublicKey;
  /** Resolve an ancestor's funding. Return null to skip an ancestor (e.g. dry swig). */
  resolveAncestor: (ancestorNode: PublicKey) => Promise<{
    ancestorSwig: PublicKey;
    financierAta: PublicKey;
    maxCover: bigint;
    assembleSignV2?: AssembleSignV2;
  } | null>;
}

export interface CascadeSeizeResult {
  steps: CascadeStep[];
  /** Shortfall still uncovered after the cascade (0 ⇒ fully covered). */
  remainingShortfall: bigint;
}

export class GraphClient {
  constructor(
    public readonly connection: Connection,
    public readonly programId: PublicKey = DEXTER_VAULT_PROGRAM_ID,
  ) {}

  /** Resolve a vault's drawing node + ancestor chain (child→parent, excl. leaf). */
  resolveDrawChain(userVaultPda: PublicKey) {
    return resolveDrawChain(this.connection, userVaultPda);
  }

  /** Build a create_node instruction (pure; no chain). */
  createNode(p: GraphCreateNodeParams): TransactionInstruction {
    return buildCreateNodeInstruction(p);
  }

  /** The borrow — resolves drawing node + chain, returns draw ix + SignV2 ixs. */
  draw(p: DrawCreditParams): Promise<TransactionInstruction[]> {
    return drawCredit({ ...p, connection: this.connection });
  }

  /** The paydown — resolves drawing node + chain, returns repay ix + SignV2 ixs. */
  repay(p: RepayCreditParams): Promise<TransactionInstruction[]> {
    return repayCredit({ ...p, connection: this.connection });
  }

  /** Cut the parent edge (+ optionally acquire/keep a root). Pure instruction. */
  emancipate(p: GraphEmancipateParams): TransactionInstruction {
    return buildEmancipateInstruction(p);
  }

  /** Freeze/thaw a subtree. Pure instruction. */
  freeze(p: GraphFreezeParams): TransactionInstruction {
    return buildSetFreezeInstruction(p);
  }

  /**
   * Assemble a draw and simulate it (sigVerify off, blockhash replaced) so a
   * caller can read CU + logs WITHOUT a validator. The LIVE depth-N "does depth-8
   * fit one tx" measurement is the e2e's job (Task 15); this is the mechanism.
   */
  async simulateDraw(p: SimulateDrawParams): Promise<SimulatedTransactionResponse> {
    const ixs = await this.draw(p);
    const { blockhash } = await this.connection.getLatestBlockhash('confirmed');
    const msg = new TransactionMessage({
      payerKey: p.feePayer,
      recentBlockhash: blockhash,
      instructions: ixs,
    }).compileToV0Message(p.lookupTables ?? []);
    const tx = new VersionedTransaction(msg);
    const sim = await this.connection.simulateTransaction(tx, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: 'confirmed',
    });
    return sim.value;
  }

  /**
   * RUNG-3 cascade: walk the defaulted leaf's ancestors nearest→root, building a
   * seize_ancestor leg per ancestor (each covering a slice of the shortfall) until
   * the shortfall is covered or the root is exhausted. Each leg's money moves the
   * ancestor's own collateral → financier via the ancestor swig's SignV2. The
   * shared `chain` (the leaf's ancestor list) is attached to EVERY leg so the
   * Decrement traverse lowers each ancestor's subtree_draw.
   */
  async cascadeSeize(p: CascadeSeizeParams): Promise<CascadeSeizeResult> {
    const leaf = await readPrincipalNode(this.connection, p.defaultedNode);
    if (!leaf) throw new Error(`defaulted node ${p.defaultedNode.toBase58()} not found`);
    let remaining = BigInt(leaf.shortfall);
    const path = await walkAncestors(this.connection, p.defaultedNode);
    const chain = path.slice(1); // ancestors, child→parent
    const steps: CascadeStep[] = [];

    for (const ancestorNode of chain) {
      if (remaining === 0n) break;
      const funding = await p.resolveAncestor(ancestorNode);
      if (!funding || funding.maxCover === 0n) continue;
      const amount = remaining < funding.maxCover ? remaining : funding.maxCover;
      if (amount === 0n) continue;

      const vaultIx = buildSeizeAncestorInstruction({
        ancestorSwig: funding.ancestorSwig,
        ancestorNode,
        defaultedNode: p.defaultedNode,
        dexterAuthority: p.dexterAuthority,
        amount,
        chain,
      });
      const assemble = funding.assembleSignV2 ?? defaultAssembleSignV2;
      const signV2Ixs = await assemble({
        connection: this.connection,
        swigAddress: funding.ancestorSwig,
        feePayer: p.feePayer,
        vaultIx,
        transfers: [{ destinationAta: funding.financierAta, amount }],
      });
      // CONTRACT: signV2Ixs INCLUDES vaultIx (see drawCredit / assembleSignV2.ts).
      // Re-adding vaultIx would run seize_ancestor TWICE and revert.
      steps.push({ ancestorNode, amount, instructions: [...signV2Ixs] });
      remaining -= amount;
    }

    return { steps, remainingShortfall: remaining };
  }
}
