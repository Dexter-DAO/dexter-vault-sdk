/**
 * The injectable Swig SignV2 assembler for ./tab verbs. Default wires the real
 * @swig-wallet/kit; tests inject a fake. Mirrors factoring/instantPayout.ts.
 * The vault instruction (settle_tab_voucher / draw_credit / etc.) is passed as
 * `vaultIx` and becomes the SignV2 preInstruction.
 */
import { PublicKey, TransactionInstruction, Connection } from '@solana/web3.js';
import { fetchSwig, getSignInstructions, getSwigWalletAddress } from '@swig-wallet/kit';
import { getProgramExecBasedAuthority } from '@swig-wallet/lib';
import { address as kitAddress } from '@solana/kit';
import { getTransferCheckedInstruction } from '@solana-program/token';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { USDC_MAINNET } from '../constants/index.js';
import { kitInstructionsToWeb3, getRpc } from '../kit/index.js';
import type { TabTransfer } from './types.js';

// Legacy fallback ONLY: a swig created before the 2026-07-01 role reconciliation
// may not carry the ProgramExec marker for the vault ix being wrapped. Modern
// swigs (set_swig_atomic / swigBundle) carry all 6; we resolve BY MARKER below.
const LEGACY_PROGRAM_EXEC_ROLE_ID = 1;
const USDC_DECIMALS = 6;

/**
 * Resolve the swig role that authorizes `vaultIx`'s ProgramExec SignV2 by MATCHING
 * the role's on-chain instruction-prefix marker to `vaultIx`'s Anchor discriminator
 * (its first 8 data bytes). This replaces the old hardcoded role-index 1: repay
 * must sign through the repay role, seize through seize, settle_tab through
 * settle_tab — a fixed index silently reverts the money leg whenever the ix ≠
 * finalize_withdrawal (the observed recourse-revert bug). Returns null (→ legacy
 * fallback) only when no ProgramExec role matches — a truly pre-reconciliation swig.
 */
function resolveProgramExecRoleId(
  swig: unknown,
  vaultIx: TransactionInstruction,
): number | null {
  const marker = vaultIx.data.subarray(0, 8);
  const roles: any[] = (swig as any)?.roles ?? [];
  for (let i = 0; i < roles.length; i++) {
    const authority = roles[i]?.authority;
    if (!authority) continue;
    const pe = getProgramExecBasedAuthority(authority);
    if (!pe) continue;
    const prefix = pe.instructionPrefix;
    if (prefix.length >= marker.length && marker.every((b, j) => prefix[j] === b)) {
      const id = roles[i]?.id;
      return typeof id === 'number' ? id : i;
    }
  }
  return null;
}

export interface AssembleSignV2Args {
  connection: Connection;
  swigAddress: PublicKey;
  feePayer: PublicKey;
  /** The single preceding instruction Swig ProgramExec authenticates against. */
  vaultIx: TransactionInstruction;
  transfers: TabTransfer[];
}

/** CONTRACT: the returned array must CONTAIN vaultIx (ordered before the SignV2).
 *  The real kit assembler satisfies this automatically — getSignInstructions
 *  returns its preInstructions in the output list. Injected fakes must echo
 *  vaultIx the same way or the composed tx will be missing the vault leg. */
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

  // Sign through the role whose ProgramExec marker matches a.vaultIx (repay→repay
  // role, seize→seize, settle_tab→settle_tab). Falls back to the legacy index
  // only for a pre-reconciliation swig that lacks the matching marker.
  const roleId = resolveProgramExecRoleId(swig, a.vaultIx) ?? LEGACY_PROGRAM_EXEC_ROLE_ID;

  const signIx = await getSignInstructions(
    swig,
    roleId,
    transferIxs as any,
    false,
    { payer: kitAddress(a.feePayer.toBase58()), preInstructions: [a.vaultIx] } as any,
  );

  return kitInstructionsToWeb3(signIx);
};
