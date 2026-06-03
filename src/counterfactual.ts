/**
 * Counterfactual Swig address derivation — derive both Swig PDAs
 * (state + wallet-address) without an RPC call and without deploying.
 *
 * Used by enrollment flows that show a user a deposit address before the
 * Swig is on chain.
 */

import { findSwigSystemAddressPdaRaw } from '@swig-wallet/lib';
import { expectedSwigAddressFor } from './instructions/swigBundle.js';

export interface CounterfactualAddresses {
  swigStateAddress: string;
  swigWalletAddress: string;
}

export async function deriveCounterfactualAddresses(args: {
  identitySeed: Uint8Array;
  hmacKey: Uint8Array;
}): Promise<CounterfactualAddresses> {
  if (args.identitySeed.length === 0) {
    throw new Error('identitySeed must be non-empty');
  }
  const swigStateAddress = await expectedSwigAddressFor(args.identitySeed, args.hmacKey);
  const [walletPda] = await findSwigSystemAddressPdaRaw(swigStateAddress);
  return {
    swigStateAddress,
    swigWalletAddress: walletPda.toBase58(),
  };
}
