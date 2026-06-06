/**
 * Instant-payout (factoring) — full atomic transaction assembly.
 *
 *   [0] vault::settle_locked_voucher  (financier = holder; validates + mutates)
 *   [1] swig::SignV2(TransferChecked × {1 or 2})  (sourced from swig_wallet_ata)
 *         - sellerReceives  → sellerAta
 *         - financierSpread → financierAta  (omitted when spread === 0)
 *
 * The default `assembleSignV2` wires the real @swig-wallet/kit + @solana-program/token
 * path (mirrors dexter-api buildFinalizeWithdrawExtra). It's injectable so the
 * composition is unit-testable without live swig state.
 */
import { PublicKey, TransactionInstruction, Connection } from '@solana/web3.js';
import { fetchSwig, getSignInstructions, getSwigWalletAddress } from '@swig-wallet/kit';
import { address as kitAddress } from '@solana/kit';
import { getTransferCheckedInstruction } from '@solana-program/token';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { buildSettleLockedVoucherInstruction } from '../instructions/lockedClaim.js';
import { USDC_MAINNET } from '../constants/index.js';
import { computeFactoringSplit } from './split.js';
import { kitInstructionsToWeb3, getRpc } from './kitBridge.js';

const VAULT_PROGRAM_EXEC_ROLE_ID = 1; // swig role index for ProgramExec (see dexter-api)
const USDC_DECIMALS = 6;

export interface InstantTransfer {
  destinationAta: PublicKey;
  amount: bigint;
}

export interface AssembleSignV2Args {
  connection: Connection;
  swigAddress: PublicKey;
  feePayer: PublicKey;
  /** The single preceding instruction Swig ProgramExec authenticates against. */
  settleIx: TransactionInstruction;
  transfers: InstantTransfer[];
}

export type AssembleSignV2 = (args: AssembleSignV2Args) => Promise<TransactionInstruction[]>;

export interface InstantPayoutParams {
  connection: Connection;
  swigAddress: PublicKey;
  claimPda: PublicKey;
  vaultPda: PublicKey;
  /** The current claim holder collecting — the financier. Signs settle. */
  financier: PublicKey;
  dexterAuthority: PublicKey;
  claimAmount: bigint;
  /** Operator-supplied spread. 0 ≤ spread ≤ claimAmount. */
  financierSpread: bigint;
  sellerAta: PublicKey;
  financierAta: PublicKey;
  /** Pays ATA rent / tx fees in the SignV2 build. */
  feePayer: PublicKey;
  /** Injectable for unit tests; defaults to the real swig-kit assembler. */
  assembleSignV2?: AssembleSignV2;
}

export async function buildInstantPayoutInstructions(
  p: InstantPayoutParams,
): Promise<TransactionInstruction[]> {
  const split = computeFactoringSplit({
    claimAmount: p.claimAmount,
    financierSpread: p.financierSpread,
  });

  const settleIx = buildSettleLockedVoucherInstruction({
    swigAddress: p.swigAddress,
    claimPda: p.claimPda,
    vaultPda: p.vaultPda,
    holder: p.financier,
    dexterAuthority: p.dexterAuthority,
  });

  const transfers: InstantTransfer[] = [
    { destinationAta: p.sellerAta, amount: split.sellerReceives },
  ];
  if (split.financierSpread > 0n) {
    transfers.push({ destinationAta: p.financierAta, amount: split.financierSpread });
  }

  const assemble = p.assembleSignV2 ?? defaultAssembleSignV2;
  const signV2Ixs = await assemble({
    connection: p.connection,
    swigAddress: p.swigAddress,
    feePayer: p.feePayer,
    settleIx,
    transfers,
  });

  return [settleIx, ...signV2Ixs];
}

/** Real SignV2 assembler — mirrors dexter-api buildFinalizeWithdrawExtra. */
const defaultAssembleSignV2: AssembleSignV2 = async (a) => {
  const rpc = getRpc(a.connection);
  const swig = await fetchSwig(rpc, kitAddress(a.swigAddress.toBase58()));
  if (!swig) throw new Error(`factoring: swig not found on-chain: ${a.swigAddress.toBase58()}`);

  const swigWalletKitAddr = await getSwigWalletAddress(swig);
  const swigWalletPda = new PublicKey(String(swigWalletKitAddr));
  const usdcMint = new PublicKey(USDC_MAINNET);
  const sourceAta = getAssociatedTokenAddressSync(usdcMint, swigWalletPda, true);

  const transferIxs = a.transfers.map((t) =>
    getTransferCheckedInstruction({
      source: kitAddress(sourceAta.toBase58()),
      mint: kitAddress(usdcMint.toBase58()),
      destination: kitAddress(t.destinationAta.toBase58()),
      authority: swigWalletKitAddr,
      amount: t.amount,
      decimals: USDC_DECIMALS,
    }),
  );

  const signIx = await getSignInstructions(
    swig,
    VAULT_PROGRAM_EXEC_ROLE_ID,
    transferIxs as any,
    false,
    { payer: kitAddress(a.feePayer.toBase58()), preInstructions: [a.settleIx] } as any,
  );

  return kitInstructionsToWeb3(signIx);
};
