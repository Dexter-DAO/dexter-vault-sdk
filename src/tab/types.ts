import type { PublicKey } from '@solana/web3.js';

/** A single SignV2 transfer leg (destination + amount). */
export interface TabTransfer {
  destinationAta: PublicKey;
  amount: bigint;
}
