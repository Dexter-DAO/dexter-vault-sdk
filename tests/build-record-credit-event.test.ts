import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { buildRecordCreditEventInstruction } from "../src/instructions/creditIdentity.js";
import { DISCRIMINATORS } from "../src/constants/index.js";
import { deriveCreditRootPda, deriveCreditEventPda } from "../src/credit/derive.js";

const N = Uint8Array.from(Array(32).fill(7));
const AGENT = Uint8Array.from(Array(32).fill(9));
const vault = PublicKey.unique(); const payer = PublicKey.unique();

describe("buildRecordCreditEventInstruction", () => {
  const ix = buildRecordCreditEventInstruction({ nullifier: N, eventCount: 0n, vault, agentId: AGENT, kind: 1, amount: 500_000n, payer });
  it("data = disc ‖ agent_id(32) ‖ kind(1) ‖ amount(u64le)", () => {
    expect(ix.data.length).toBe(8 + 32 + 1 + 8);
    expect(Array.from(ix.data.subarray(0, 8))).toEqual(Array.from(DISCRIMINATORS.record_credit_event));
    expect(ix.data.readUInt8(8 + 32)).toBe(1);
    expect(ix.data.readBigUInt64LE(8 + 32 + 1)).toBe(500_000n);
  });
  it("metas: credit_root(w), vault(ro), credit_event(w), payer(signer); NO dexter_authority", () => {
    const [root] = deriveCreditRootPda(N); const [ev] = deriveCreditEventPda(N, 0n);
    expect(ix.keys[0].pubkey.equals(root)).toBe(true); expect(ix.keys[0].isWritable).toBe(true);
    expect(ix.keys[1].pubkey.equals(vault)).toBe(true); expect(ix.keys[1].isWritable).toBe(false);
    expect(ix.keys[2].pubkey.equals(ev)).toBe(true); expect(ix.keys[2].isWritable).toBe(true);
    expect(ix.keys[3].isSigner).toBe(true);
    expect(ix.keys.some((k) => k.isSigner && !k.pubkey.equals(payer))).toBe(false);
  });
});
