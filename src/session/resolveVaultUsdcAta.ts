/**
 * resolveVaultUsdcAta — the single source of truth for "the vault's USDC ATA,
 * or null if it doesn't exist on-chain."
 *
 * register_session_key reads the vault swig-wallet's USDC ATA to compute
 * backing = own_USDC + available_standby_credit. A $0 credit-only vault never
 * receives a deposit, so its ATA is never created (an ATA is born on the first
 * incoming transfer). The program's `vault_usdc_ata` account is therefore
 * OPTIONAL: when absent, own-USDC is counted as 0 and backing is the standby
 * credit alone.
 *
 * Every caller that builds register_session_key (the @dexterai/x402 tab
 * adapter, dexter-api's grant route, the prove harnesses) MUST resolve the ATA
 * through THIS function rather than deriving it locally — that keeps the
 * derive-and-probe decision in one place (no drift, no re-implementation) and
 * feeds the `PublicKey | null` straight into {@link buildRegisterSessionKeyInstruction}.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';

import { USDC_MAINNET } from '../constants/index.js';
import { deriveSwigWalletAddress } from '../instructions/withdraw.js';

/** Derive the vault swig-wallet's USDC ATA address (pure, no RPC). The owner is
 *  the canonical swig WALLET PDA (off-curve), not the swig state account. */
export function deriveVaultUsdcAta(
  swigAddress: PublicKey,
  usdcMint: PublicKey = new PublicKey(USDC_MAINNET),
): PublicKey {
  return getAssociatedTokenAddressSync(usdcMint, deriveSwigWalletAddress(swigAddress), true);
}

/**
 * Resolve the vault's USDC ATA for register_session_key: returns the ATA
 * address if it exists on-chain, else `null` (credit-only vault). Pass the
 * result straight to `buildRegisterSessionKeyInstruction({ vaultUsdcAta })`.
 *
 * A self-funded vault always has its ATA (created on deposit), so this returns
 * its address and the balance is counted. A credit-only vault returns null,
 * which the program treats as own-USDC = 0. Returning null can only ever
 * understate backing — never inflate it — so it is safe.
 */
export async function resolveVaultUsdcAta(
  connection: Connection,
  swigAddress: PublicKey,
  usdcMint: PublicKey = new PublicKey(USDC_MAINNET),
): Promise<PublicKey | null> {
  const ata = deriveVaultUsdcAta(swigAddress, usdcMint);
  const info = await connection.getAccountInfo(ata);
  return info ? ata : null;
}
