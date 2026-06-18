import { enrollPasskey } from './enroll.js';
import { resolveVaultAddresses } from './deriveAddresses.js';
import type { DepositAddressResolver } from './types.js';

export interface CreateVaultConfig {
  rpId: string;
  rpName: string;
  userName: string;
  /** Dexter compute call for the Swig/deposit address (no chain write). */
  resolveDepositAddress: DepositAddressResolver;
  /** Idempotent resume: skip enrollment and re-derive for a known handle. */
  existingUserHandle?: Uint8Array;
}

export interface CreateVaultResult {
  vaultPda: string;
  swigStateAddress: string;
  receiveAddress: string | null;
  userHandle: Uint8Array;
  credentialId: Uint8Array;
}

/**
 * Create a counterfactual passkey vault with ZERO on-chain writes. Generates a
 * userHandle, runs WebAuthn create(), derives the vault PDA client-side, and
 * fetches the Swig/deposit address from the supplied Dexter compute resolver.
 * Nothing is deployed; the deposit address is usable immediately (the sender
 * creates the ATA on first transfer). On-chain deploy is Plan B (funded).
 *
 * Resume: pass existingUserHandle to skip the create() ceremony. credentialId
 * is unavailable on a pure resume (no ceremony), so it returns empty — callers
 * that need the credentialId on resume should persist it from the first create.
 */
export async function createVault(config: CreateVaultConfig): Promise<CreateVaultResult> {
  let userHandle: Uint8Array;
  let credentialId: Uint8Array;

  if (config.existingUserHandle) {
    userHandle = config.existingUserHandle;
    credentialId = new Uint8Array(0);
  } else {
    const enrollment = await enrollPasskey({
      rpId: config.rpId,
      rpName: config.rpName,
      userName: config.userName,
    });
    userHandle = enrollment.userHandle;
    credentialId = enrollment.credentialId;
  }

  const addrs = await resolveVaultAddresses(userHandle, config.resolveDepositAddress);

  return {
    vaultPda: addrs.vaultPda,
    swigStateAddress: addrs.swigStateAddress,
    receiveAddress: addrs.receiveAddress,
    userHandle,
    credentialId,
  };
}
