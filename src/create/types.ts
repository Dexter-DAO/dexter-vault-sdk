/**
 * The Dexter compute call that returns the Swig/deposit address. It performs
 * NO on-chain write — it HMAC-derives swigId (= HMAC(sessionMasterSecret,
 * userHandle)) and findProgramAddresses the Swig + wallet PDAs server-side,
 * because the secret cannot live in client code (Plan A Global Constraints).
 */
export type DepositAddressResolver = (
  userHandle: Uint8Array,
) => Promise<{ swigStateAddress: string; receiveAddress: string | null }>;

/** Fully-resolved counterfactual vault addresses (nothing deployed yet). */
export interface VaultAddresses {
  vaultPda: string;
  swigStateAddress: string;
  /** Swig wallet-address PDA — the deposit target. null when unavailable;
   *  NEVER substitute swigStateAddress (unspendable config PDA). */
  receiveAddress: string | null;
}
