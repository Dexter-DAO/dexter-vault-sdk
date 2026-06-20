import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { buildEstablishCreditRootInstruction } from "../src/instructions/creditIdentity.js";
import { DISCRIMINATORS } from "../src/constants/index.js";
import { deriveCreditRootPda } from "../src/credit/derive.js";

const pi = Array.from({ length: 15 }, (_, i) => Uint8Array.from(Array(32).fill(i)));
const payer = PublicKey.unique();

describe("buildEstablishCreditRootInstruction", () => {
  const ix = buildEstablishCreditRootInstruction({
    proofA: new Uint8Array(64), proofB: new Uint8Array(128), proofC: new Uint8Array(64),
    publicInputs: pi, payer,
  });
  it("data = disc ‖ 64 ‖ 128 ‖ 64 ‖ 480", () => {
    expect(ix.data.length).toBe(8 + 64 + 128 + 64 + 15 * 32);
    expect(Array.from(ix.data.subarray(0, 8))).toEqual(Array.from(DISCRIMINATORS.establish_credit_root));
  });
  it("credit_root meta is the nullifier-seeded PDA and writable", () => {
    const [rootPda] = deriveCreditRootPda(pi[0]);
    expect(ix.keys[1].pubkey.equals(rootPda)).toBe(true);
    expect(ix.keys[1].isWritable).toBe(true);
    expect(ix.keys[2].pubkey.equals(payer)).toBe(true);
    expect(ix.keys[2].isSigner).toBe(true);
  });
  it("rejects malformed proof lengths", () => {
    expect(() => buildEstablishCreditRootInstruction({
      proofA: new Uint8Array(63), proofB: new Uint8Array(128), proofC: new Uint8Array(64), publicInputs: pi, payer,
    })).toThrow();
  });
});
