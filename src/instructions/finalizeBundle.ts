/**
 * The ONE production assembly of a finalize-withdrawal transaction tail.
 * dexter-api consumes this; the vault repo's fork e2e consumes this. Program
 * and client are therefore proven against the same bytes — the drift that
 * bricked withdraw on 2026-07-03 (two-leg fee model vs one-leg bind, wallet vs
 * ATA destination) is structurally impossible to reintroduce silently.
 *
 * On-chain contract (finalize_withdrawal, program ≥ the 2026-07 fee upgrade):
 *   leg0: TransferChecked  gross − fee → ATA(pending.destination, usdc_mint)
 *   leg1: TransferChecked  fee         → ATA(graph_config.fee_treasury, usdc_mint)
 * wrapped in ONE Swig::SignV2, both amounts and destinations byte-reconciled,
 * fee read from GraphConfig (never a local constant).
 *
 * ORDER CONTRACT (on-chain enforced, both adjacencies):
 *   [ComputeBudget?, ...preInstructions, secp256r1 precompile, finalize, SignV2]
 * — the passkey verifier requires the precompile at current_index − 1 of the
 * finalize ix, and the money-leg decoder requires the SignV2 at
 * current_index + 1. So the optional destination-ATA create (preInstructions)
 * rides BEFORE the precompile, and NOTHING sits between precompile → finalize
 * → SignV2. The caller supplies the precompile (it owns the WebAuthn
 * signature) and composes:
 *   [computeBudgetIx, ...bundle.preInstructions, precompileIx, ...bundle.instructions]
 */

import { Connection, PublicKey, TransactionInstruction } from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
} from '@solana/spl-token';

import { readVaultOnchain } from '../reader/accountReader.js';
import { readGraphConfigOnchain } from '../reader/graphConfig.js';
import { defaultAssembleSignV2 } from '../tab/assembleSignV2.js';
import { USDC_MAINNET } from '../constants/index.js';
import {
  buildFinalizeWithdrawalInstruction,
  deriveSwigWalletAddress,
} from './withdraw.js';

export interface FinalizeWithdrawBundleParams {
  connection: Connection;
  swigAddress: PublicKey;
  vaultPda: PublicKey;
  /** Fee payer for the tx (also pays destination-ATA rent when created). */
  feePayer: PublicKey;
  /** WebAuthn clientDataJSON for the finalize op-msg the passkey signed. */
  clientDataJSON: Uint8Array;
  /** WebAuthn authenticatorData for the same signature. */
  authenticatorData: Uint8Array;
  /** The vault's welded PrincipalNode; null/undefined for a plain vault. */
  node?: PublicKey | null;
}

export interface FinalizeWithdrawBundle {
  /** Setup that must run BEFORE the secp256r1 precompile (today: the optional
   *  destination-ATA create). Empty when no setup is needed. */
  preInstructions: TransactionInstruction[];
  /** The adjacency-locked pair: [finalize_withdrawal, SignV2]. The caller's
   *  precompile instruction must sit IMMEDIATELY before these. */
  instructions: TransactionInstruction[];
  grossAtomic: bigint;
  feeAtomic: bigint;
  userReceivesAtomic: bigint;
  destinationAtaCreated: boolean;
  feeTreasury: PublicKey;
}

export async function buildFinalizeWithdrawBundle(
  p: FinalizeWithdrawBundleParams,
): Promise<FinalizeWithdrawBundle> {
  const vault = await readVaultOnchain(p.connection, p.vaultPda);
  if (!vault.pendingWithdrawal) {
    throw Object.assign(new Error('no_pending_withdrawal'), {
      code: 'no_pending_withdrawal',
    });
  }

  const cfg = await readGraphConfigOnchain(p.connection);
  // assembleSignV2 derives the source ATA against USDC_MAINNET internally; a
  // cluster whose canonical mint differs would build a mismatched leg — fail
  // loud here instead of letting the program reject it.
  if (cfg.usdcMint.toBase58() !== USDC_MAINNET) {
    throw new Error(
      `graph_config.usdc_mint ${cfg.usdcMint.toBase58()} != USDC_MAINNET — unsupported cluster`,
    );
  }

  const gross = BigInt(vault.pendingWithdrawal.amount);
  const fee = cfg.withdrawalFeeAtomic;
  if (gross <= fee) {
    throw Object.assign(new Error('withdrawal_below_fee'), {
      code: 'withdrawal_below_fee',
    });
  }
  const net = gross - fee;

  const destOwner = new PublicKey(vault.pendingWithdrawal.destination);
  const destAta = getAssociatedTokenAddressSync(cfg.usdcMint, destOwner, true);
  const treasuryAta = getAssociatedTokenAddressSync(cfg.usdcMint, cfg.feeTreasury, true);
  const swigWallet = deriveSwigWalletAddress(p.swigAddress);
  const vaultUsdcAta = getAssociatedTokenAddressSync(cfg.usdcMint, swigWallet, true);

  const vaultIx = buildFinalizeWithdrawalInstruction({
    vaultPda: p.vaultPda,
    swigAddress: p.swigAddress,
    vaultUsdcAta,
    node: p.node,
    clientDataJSON: p.clientDataJSON,
    authenticatorData: p.authenticatorData,
  });

  // Returns […, vaultIx, signV2] — assembleSignV2's contract keeps vaultIx
  // immediately before the SignV2, satisfying both Swig's ProgramExec
  // authentication and the program's current_index+1 envelope parse.
  const tail = await defaultAssembleSignV2({
    connection: p.connection,
    swigAddress: p.swigAddress,
    feePayer: p.feePayer,
    vaultIx,
    transfers: [
      { destinationAta: destAta, amount: net },
      { destinationAta: treasuryAta, amount: fee },
    ],
  });

  const destInfo = await p.connection.getAccountInfo(destAta);
  const destinationAtaCreated = destInfo === null;
  const preInstructions: TransactionInstruction[] = destinationAtaCreated
    ? [
        createAssociatedTokenAccountInstruction(
          p.feePayer,
          destAta,
          destOwner,
          cfg.usdcMint,
        ),
      ]
    : [];

  return {
    preInstructions,
    instructions: tail,
    grossAtomic: gross,
    feeAtomic: fee,
    userReceivesAtomic: net,
    destinationAtaCreated,
    feeTreasury: cfg.feeTreasury,
  };
}
