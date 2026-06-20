// tests/credit-derive.test.ts
import { describe, it, expect } from "vitest";
import { deriveIdentityClaim, deriveCreditRootPda, deriveCreditEventPda } from "../src/credit/derive.js";

const N = Uint8Array.from(Array.from({ length: 32 }, (_, i) => i));        // 00..1f
const AGENT = Uint8Array.from(Array.from({ length: 32 }, (_, i) => i + 16)); // 10..2f

describe("credit derive", () => {
  it("identity claim matches the on-chain SHA256(nullifier‖agent_id) vector", () => {
    expect(Buffer.from(deriveIdentityClaim(N, AGENT)).toString("hex"))
      .toBe("e1161913efb7b8306e12fa86919ea6261526140ba770d760f4e26f5433ce7b95");
  });
  it("derives stable PDAs", () => {
    const [root] = deriveCreditRootPda(N);
    const [ev] = deriveCreditEventPda(N, 0n);
    expect(root.toBase58()).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(ev.toBase58()).not.toBe(root.toBase58());
  });
});
