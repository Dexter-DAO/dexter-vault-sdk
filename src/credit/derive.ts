// src/credit/derive.ts
import { PublicKey } from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha256";
import {
  DEXTER_VAULT_PROGRAM_ID,
  CREDIT_ROOT_SEED,
  CREDIT_EVENT_SEED,
  PRINCIPAL_NODE_SEED,
  GRAPH_CONFIG_SEED,
  EVENT_AUTHORITY_SEED,
} from "../constants/index.js";

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

// ── Recourse graph PDAs ─────────────────────────────────────────────────────

/** PrincipalNode PDA: `[b"principal", node_id]`. node_id is the stable identity
 *  seed component (survives re-rooting). Mirrors create_node.rs's seeds. */
export function derivePrincipalNodePda(nodeId: Uint8Array, programId = DEXTER_VAULT_PROGRAM_ID): [PublicKey, number] {
  if (nodeId.length !== 32) throw new Error("nodeId must be 32 bytes");
  return PublicKey.findProgramAddressSync([Buffer.from(PRINCIPAL_NODE_SEED), Buffer.from(nodeId)], programId);
}

/** GraphConfig singleton PDA: `[b"graph_config"]`. The admin spine (pause/tunables). */
export function deriveGraphConfigPda(programId = DEXTER_VAULT_PROGRAM_ID): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from(GRAPH_CONFIG_SEED)], programId);
}

/** Anchor `#[event_cpi]` authority PDA: `[b"__event_authority"]`. The trailing
 *  (event_authority, program) pair every emit_cpi! instruction requires. */
export function deriveEventAuthorityPda(programId = DEXTER_VAULT_PROGRAM_ID): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from(EVENT_AUTHORITY_SEED)], programId);
}
