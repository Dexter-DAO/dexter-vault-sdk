import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { decodeCreditRoot, decodeCreditEvent } from "../src/reader/creditRootReader.js";
import {
  CREDIT_ROOT_DISCRIMINATOR,
  CREDIT_ROOT_DISCRIMINATOR_B58,
  CREDIT_EVENT_DISCRIMINATOR,
  CREDIT_EVENT_DISCRIMINATOR_B58,
  PRINCIPAL_NODE_DISCRIMINATOR,
  PRINCIPAL_NODE_DISCRIMINATOR_B58,
  GRAPH_CONFIG_DISCRIMINATOR,
  GRAPH_CONFIG_DISCRIMINATOR_B58,
} from "../src/constants/index.js";

function rootBuf(eventCount: bigint): Buffer {
  const b = Buffer.alloc(58);
  Buffer.from(CREDIT_ROOT_DISCRIMINATOR).copy(b, 0);
  b.writeUInt8(1, 8); b.writeUInt8(254, 9);
  Buffer.from(Array(32).fill(5)).copy(b, 10);
  b.writeBigInt64LE(1_700_000_000n, 42);
  b.writeBigUInt64LE(eventCount, 50);
  return b;
}

describe("credit readers", () => {
  it("decodes CreditRoot fixed layout", () => {
    const s = decodeCreditRoot(PublicKey.unique(), rootBuf(3n));
    expect(s.version).toBe(1); expect(s.bump).toBe(254);
    expect(Buffer.from(s.nullifier).equals(Buffer.from(Array(32).fill(5)))).toBe(true);
    expect(s.eventCount).toBe(3n);
  });
  it("rejects wrong discriminator", () => {
    const bad = rootBuf(0n); bad.writeUInt8(0, 0);
    expect(() => decodeCreditRoot(PublicKey.unique(), bad)).toThrow();
  });
  it("decodes CreditEvent fixed layout", () => {
    const b = Buffer.alloc(99);
    Buffer.from(CREDIT_EVENT_DISCRIMINATOR).copy(b, 0);
    b.writeUInt8(1, 8); b.writeUInt8(253, 9);
    Buffer.from(Array(32).fill(6)).copy(b, 10);
    b.writeBigUInt64LE(2n, 42);
    PublicKey.default.toBuffer().copy(b, 50);
    b.writeBigInt64LE(1_700_000_111n, 82);
    b.writeUInt8(1, 90); b.writeBigUInt64LE(750_000n, 91);
    const e = decodeCreditEvent(PublicKey.unique(), b);
    expect(e.seq).toBe(2n); expect(e.kind).toBe(1); expect(e.amount).toBe(750_000n);
  });
  it("b58 discriminator constants match their bytes", () => {
    expect(CREDIT_ROOT_DISCRIMINATOR_B58).toBe(bs58.encode(Buffer.from(CREDIT_ROOT_DISCRIMINATOR)));
    expect(CREDIT_EVENT_DISCRIMINATOR_B58).toBe(bs58.encode(Buffer.from(CREDIT_EVENT_DISCRIMINATOR)));
    expect(PRINCIPAL_NODE_DISCRIMINATOR_B58).toBe(bs58.encode(Buffer.from(PRINCIPAL_NODE_DISCRIMINATOR)));
    expect(GRAPH_CONFIG_DISCRIMINATOR_B58).toBe(bs58.encode(Buffer.from(GRAPH_CONFIG_DISCRIMINATOR)));
  });
});
