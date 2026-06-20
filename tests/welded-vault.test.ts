// tests/welded-vault.test.ts
import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { makeWeldedVaultAgentId, deriveWeldedVaultPda, buildWeldedVaultInstruction } from "../src/credit/weldedVault.js";
import { deriveIdentityClaim } from "../src/credit/derive.js";
import { DISCRIMINATORS } from "../src/constants/index.js";

const N = Uint8Array.from(Array(32).fill(3));

describe("welded vault", () => {
  it("agent_id is 32 random bytes (non-constant)", () => {
    const a = makeWeldedVaultAgentId(), b = makeWeldedVaultAgentId();
    expect(a.length).toBe(32);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });
  it("vault PDA derives from identity_claim[..16]", () => {
    const claim = deriveIdentityClaim(N, makeWeldedVaultAgentId());
    const [pda] = deriveWeldedVaultPda(claim);
    const [expected] = PublicKey.findProgramAddressSync([Buffer.from("vault"), Buffer.from(claim.subarray(0, 16))],
      new PublicKey("Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc"));
    expect(pda.equals(expected)).toBe(true);
  });
  it("ix data = disc ‖ passkey(33) ‖ coolingOff(u32) ‖ claim(32)", () => {
    const claim = deriveIdentityClaim(N, makeWeldedVaultAgentId());
    const passkey = Uint8Array.from([0x02, ...Array(32).fill(1)]);
    const ix = buildWeldedVaultInstruction({ identityClaim: claim, passkeyPubkey: passkey, coolingOffSeconds: 0, payer: PublicKey.unique(), dexterAuthority: PublicKey.unique() });
    expect(ix.data.length).toBe(8 + 33 + 4 + 32);
    expect(Array.from(ix.data.subarray(0, 8))).toEqual(Array.from(DISCRIMINATORS.initialize_vault));
    expect(ix.keys[2].isSigner).toBe(true); // dexter_authority signs
  });
});
