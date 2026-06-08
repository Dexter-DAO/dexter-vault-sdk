/**
 * Mechanism-B SignV2 assembler for the financier-consent vault instructions
 * (set_standby_reserve, close_standby{financier}). UNLIKE assembleSignV2.ts
 * (which wraps a TOKEN TRANSFER as the SignV2 inner payload and uses the vault ix
 * as a ProgramExec preInstruction MARKER — mechanism A), this wraps the VAULT
 * INSTRUCTION ITSELF as the inner CPI (mechanism B) — Swig invoke_signed's the
 * financier swig_wallet PDA over it, satisfying the rust Signer requirement.
 * Routed through the financier swig's Program(dexter_vault) role (caller-supplied
 * via programRoleId; NOT the hardcoded ProgramExec role the transfer path uses).
 *
 * Proven on mainnet: dexter-vault/tests/helpers/standby-reserve.ts::sendVaultCpiSignV2.
 * SIBLING of assembleSignV2.ts — never modifies it.
 */
import { PublicKey, TransactionInstruction, Connection } from '@solana/web3.js';
import { fetchSwig, getSignInstructions, getSwigWalletAddress } from '@swig-wallet/kit';
import { address as kitAddress } from '@solana/kit';
import { kitInstructionsToWeb3, getRpc } from '../kit/index.js';

/**
 * Patch the financier swig_wallet meta on the inner ix to isSigner:true so Swig
 * invoke_signed's the PDA over the inner CPI. set_standby_reserve already emits
 * isSigner:true (struct Signer); close_standby emits isSigner:false (AccountInfo,
 * shared with the user leg) and REQUIRES this patch. Idempotent. Mutates the ix's
 * key metas in place AND returns it for chaining. Throws if the swig_wallet pubkey
 * is not among the ix accounts (a wrong-ix guard).
 */
export function patchSwigWalletSigner(
  ix: TransactionInstruction,
  swigWalletPda: PublicKey,
): TransactionInstruction {
  let found = false;
  for (const k of ix.keys) {
    if (k.pubkey.equals(swigWalletPda)) {
      k.isSigner = true;
      found = true;
    }
  }
  if (!found) {
    throw new Error(
      `assembleStandbyReserveSignV2: swig_wallet ${swigWalletPda.toBase58()} not found in inner ix accounts`,
    );
  }
  return ix;
}

export interface AssembleStandbyReserveSignV2Args {
  connection: Connection;
  financierSwig: PublicKey;
  feePayer: PublicKey;
  /** The vault ix (set_standby_reserve / close_standby{financier}) to run as the
   *  SignV2 INNER CPI. Its swig_wallet meta is patched to signer here. */
  vaultIx: TransactionInstruction;
  /** The financier swig role index holding the Program(dexter_vault) permission. */
  programRoleId: number;
}

export type AssembleStandbyReserveSignV2 =
  (args: AssembleStandbyReserveSignV2Args) => Promise<TransactionInstruction[]>;

export const defaultAssembleStandbyReserveSignV2: AssembleStandbyReserveSignV2 = async (a) => {
  const rpc = getRpc(a.connection);
  const swig = await fetchSwig(rpc, kitAddress(a.financierSwig.toBase58()));
  if (!swig) throw new Error(`standby: financier swig not found on-chain: ${a.financierSwig.toBase58()}`);

  const swigWalletKitAddr = await getSwigWalletAddress(swig);
  const swigWalletPda = new PublicKey(String(swigWalletKitAddr));

  patchSwigWalletSigner(a.vaultIx, swigWalletPda);

  const signKitIxs = await getSignInstructions(
    swig,
    a.programRoleId,
    [a.vaultIx as any], // INNER CPI = the vault ix. NOT preInstructions, NOT transfers.
    false,
    { payer: kitAddress(a.feePayer.toBase58()) } as any,
  );
  return kitInstructionsToWeb3(signKitIxs);
};
