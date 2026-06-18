import { deriveVaultPda } from '../instructions/swigBundle.js';
import type { DepositAddressResolver, VaultAddresses } from './types.js';

/**
 * Resolve a vault's counterfactual addresses with ZERO on-chain writes:
 *   - vault PDA: derived client-side from public seeds (["vault", userHandle]).
 *   - Swig + deposit address: fetched from a Dexter compute endpoint, because
 *     swigId = HMAC(sessionMasterSecret, userHandle) and the secret must stay
 *     server-side (also the anti-squat guard). See Plan A Global Constraints.
 */
export async function resolveVaultAddresses(
  userHandle: Uint8Array,
  resolveDepositAddress: DepositAddressResolver,
): Promise<VaultAddresses> {
  const { pda } = deriveVaultPda(userHandle); // throws if !== 16 bytes
  const { swigStateAddress, receiveAddress } = await resolveDepositAddress(userHandle);
  return {
    vaultPda: pda.toBase58(),
    swigStateAddress,
    // FAIL-SAFE: pass the resolver's value through verbatim; null stays null.
    // Never coalesce to swigStateAddress — depositing to the config PDA strands funds.
    receiveAddress: receiveAddress ?? null,
  };
}
