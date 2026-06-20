// src/credit/derive.ts
import { PublicKey } from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha256";
import { DEXTER_VAULT_PROGRAM_ID, CREDIT_ROOT_SEED, CREDIT_EVENT_SEED } from "../constants/index.js";

export function deriveIdentityClaim(nullifier: Uint8Array, agentId: Uint8Array): Uint8Array {
  if (nullifier.length !== 32 || agentId.length !== 32) throw new Error("nullifier and agentId must be 32 bytes");
  return sha256(Buffer.concat([Buffer.from(nullifier), Buffer.from(agentId)]));
}
export function deriveCreditRootPda(nullifier: Uint8Array, programId = DEXTER_VAULT_PROGRAM_ID): [PublicKey, number] {
  if (nullifier.length !== 32) throw new Error("nullifier must be 32 bytes");
  return PublicKey.findProgramAddressSync([Buffer.from(CREDIT_ROOT_SEED), Buffer.from(nullifier)], programId);
}
export function deriveCreditEventPda(nullifier: Uint8Array, seq: bigint, programId = DEXTER_VAULT_PROGRAM_ID): [PublicKey, number] {
  const seqLe = Buffer.alloc(8); seqLe.writeBigUInt64LE(seq);
  return PublicKey.findProgramAddressSync([Buffer.from(CREDIT_EVENT_SEED), Buffer.from(nullifier), seqLe], programId);
}
