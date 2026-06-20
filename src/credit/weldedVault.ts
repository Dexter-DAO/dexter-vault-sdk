// src/credit/weldedVault.ts
//
// Welded-vault creation: a credit-rooted vault whose PDA is welded to a
// personhood claim. identity_claim = SHA256(nullifier ‖ agent_id), with
// agent_id a random 32-byte secret (makeWeldedVaultAgentId).
//
// Reconciliation: this does NOT duplicate the initialize_vault ix builder.
// buildWeldedVaultInstruction is a thin wrapper over the existing
// buildInitializeVaultInstruction (src/instructions/initialize.ts), which
// already emits the exact byte layout (disc ‖ passkey(33) ‖ coolingOff(u32le)
// ‖ identity_claim(32)) and account order (vault(w), payer(signer,w),
// dexter_authority(signer,ro), system_program(ro)) the protocol expects.

import { randomBytes } from "node:crypto";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { DEXTER_VAULT_PROGRAM_ID } from "../constants/index.js";
import { buildInitializeVaultInstruction } from "../instructions/initialize.js";

/** The agent_id secret: 32 random bytes. Combined with the nullifier to form
 * the identity_claim. Never derive this deterministically — it is the secret. */
export function makeWeldedVaultAgentId(): Uint8Array {
  return new Uint8Array(randomBytes(32));
}

/** Vault PDA seed = [b"vault", identityClaim[..16]] (LEADING 16 bytes only). */
export function deriveWeldedVaultPda(
  identityClaim: Uint8Array,
  programId = DEXTER_VAULT_PROGRAM_ID,
): [PublicKey, number] {
  if (identityClaim.length !== 32) throw new Error("identityClaim must be 32 bytes");
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), Buffer.from(identityClaim.subarray(0, 16))],
    programId,
  );
}

export interface WeldedVaultParams {
  identityClaim: Uint8Array;
  passkeyPubkey: Uint8Array;
  coolingOffSeconds: number;
  payer: PublicKey;
  dexterAuthority: PublicKey;
}

export function buildWeldedVaultInstruction(p: WeldedVaultParams): TransactionInstruction {
  if (p.passkeyPubkey.length !== 33) {
    throw new Error("passkeyPubkey must be 33 bytes (SEC1 compressed)");
  }
  // Guarded index: length === 33 was just checked, so [0] is defined.
  const prefix = p.passkeyPubkey[0]!;
  if (prefix !== 0x02 && prefix !== 0x03) {
    throw new Error("passkeyPubkey must start 0x02/0x03");
  }
  if (p.identityClaim.length !== 32) throw new Error("identityClaim must be 32 bytes");

  const [vaultPda] = deriveWeldedVaultPda(p.identityClaim);

  return buildInitializeVaultInstruction({
    vaultPda,
    payer: p.payer,
    dexterAuthority: p.dexterAuthority,
    passkeyPubkey: p.passkeyPubkey,
    coolingOffSeconds: p.coolingOffSeconds,
    identityClaim: p.identityClaim,
  });
}
