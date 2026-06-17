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
// NOTE: import these from @swig-wallet/lib (where they are DEFINED), NOT
// @swig-wallet/kit. kit re-exports them via `export *`, which Node's ESM↔CJS
// interop (cjs-module-lexer) cannot see — importing them from kit yields
// `undefined` and the built ESM dist throws "Named export not found" at load.
// (Caught by the T10 harness preflight; vitest's resolver had masked it.)
import {
  isProgramExecAuthority,
  getProgramExecBasedAuthority,
  uint8ArraysEqual,
} from '@swig-wallet/lib';
import { address as kitAddress } from '@solana/kit';
import { getTransferCheckedInstruction } from '@solana-program/token';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { buildSettleLockedVoucherInstruction } from '../instructions/lockedClaim.js';
import { DEXTER_VAULT_PROGRAM_ID, USDC_MAINNET } from '../constants/index.js';
import { SWIG_PROGRAM_EXEC_PREFIX_SETTLE_LOCKED } from '../instructions/swigBundle.js';
import { computeFactoringSplit } from './split.js';
import { kitInstructionsToWeb3, getRpc } from './kitBridge.js';

const USDC_DECIMALS = 6;

/**
 * Minimal structural view of a fetched swig — just enough for role selection.
 * Lets unit tests pass a fake `{ roles }` without standing up real swig state.
 */
export interface RoleLike {
  /** Numeric role id passed to getSignInstructions (Role.id). */
  id: number;
  /** The role's authority (Role.authority). */
  authority: unknown;
}
export interface SwigRolesLike {
  roles: RoleLike[];
}

/**
 * Find the swig role id whose ProgramExec authority matches BOTH the given
 * program id and instruction marker (discriminator prefix).
 *
 * Robust to role ordering: fresh bundle-enrolled vaults carry settle_locked at
 * role 4, but vaults backfilled via registerProgramAuthority/the T2 script
 * append the marker at a variable index. We match by program-id + marker bytes,
 * never by a hardcoded index.
 */
export function findProgramExecRoleId(
  swig: SwigRolesLike,
  programIdBytes: Uint8Array,
  marker: Uint8Array,
): number {
  for (const role of swig.roles) {
    const authority = role.authority as any;
    if (!isProgramExecAuthority(authority)) continue;
    const pe = getProgramExecBasedAuthority(authority);
    if (!pe) continue;
    // programId is a SolPublicKey (32 bytes); instructionPrefix is up to 40
    // bytes, with instructionPrefixLen meaningful leading bytes.
    if (!uint8ArraysEqual(pe.programId.toBytes(), programIdBytes)) continue;
    const meaningful = pe.instructionPrefix.slice(0, pe.instructionPrefixLen);
    if (uint8ArraysEqual(meaningful, marker)) {
      return role.id;
    }
  }
  throw new Error(
    `factoring: swig has no settle_locked_voucher ProgramExec role — ` +
      `vault not enrolled/backfilled with the settle_locked marker`,
  );
}

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

  // CONTRACT: signV2Ixs INCLUDES settleIx (the kit returns preInstructions in its
  // ordered output — see assembleSignV2.ts). Re-adding it would run
  // settle_locked_voucher twice and revert the whole payout.
  return [...signV2Ixs];
}

/** Real SignV2 assembler — mirrors dexter-api buildFinalizeWithdrawExtra. */
const defaultAssembleSignV2: AssembleSignV2 = async (a) => {
  const rpc = getRpc(a.connection);
  const swig = await fetchSwig(rpc, kitAddress(a.swigAddress.toBase58()));
  if (!swig) throw new Error(`factoring: swig not found on-chain: ${a.swigAddress.toBase58()}`);

  const roleId = findProgramExecRoleId(
    swig as unknown as SwigRolesLike,
    Uint8Array.from(DEXTER_VAULT_PROGRAM_ID.toBytes()),
    SWIG_PROGRAM_EXEC_PREFIX_SETTLE_LOCKED,
  );

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
    roleId,
    transferIxs as any,
    false,
    { payer: kitAddress(a.feePayer.toBase58()), preInstructions: [a.settleIx] } as any,
  );

  return kitInstructionsToWeb3(signIx);
};
