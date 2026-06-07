/**
 * The injectable Swig SignV2 assembler for ./tab verbs. Default wires the real
 * @swig-wallet/kit; tests inject a fake. Mirrors factoring/instantPayout.ts.
 * The vault instruction (settle_tab_voucher / draw_credit / etc.) is passed as
 * `vaultIx` and becomes the SignV2 preInstruction.
 */
import { PublicKey, TransactionInstruction, Connection } from '@solana/web3.js';
import { fetchSwig, getSignInstructions, getSwigWalletAddress } from '@swig-wallet/kit';
import { address as kitAddress } from '@solana/kit';
import { getTransferCheckedInstruction } from '@solana-program/token';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { USDC_MAINNET } from '../constants/index.js';
import { kitInstructionsToWeb3, getRpc } from '../kit/index.js';
import type { TabTransfer } from './types.js';

const VAULT_PROGRAM_EXEC_ROLE_ID = 1; // swig role index for ProgramExec (see dexter-api)
const USDC_DECIMALS = 6;

export interface AssembleSignV2Args {
  connection: Connection;
  swigAddress: PublicKey;
  feePayer: PublicKey;
  /** The single preceding instruction Swig ProgramExec authenticates against. */
  vaultIx: TransactionInstruction;
  transfers: TabTransfer[];
}

export type AssembleSignV2 = (args: AssembleSignV2Args) => Promise<TransactionInstruction[]>;

/** Real SignV2 assembler — mirrors factoring/instantPayout.ts defaultAssembleSignV2. */
export const defaultAssembleSignV2: AssembleSignV2 = async (a) => {
  const rpc = getRpc(a.connection);
  const swig = await fetchSwig(rpc, kitAddress(a.swigAddress.toBase58()));
  if (!swig) throw new Error(`tab: swig not found on-chain: ${a.swigAddress.toBase58()}`);

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
    { payer: kitAddress(a.feePayer.toBase58()), preInstructions: [a.vaultIx] } as any,
  );

  return kitInstructionsToWeb3(signIx);
};
