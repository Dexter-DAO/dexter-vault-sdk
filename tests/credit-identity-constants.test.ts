import { describe, it, expect } from "vitest";
import { sha256 } from "@noble/hashes/sha256";
import {
  DISCRIMINATORS, CREDIT_ROOT_DISCRIMINATOR, CREDIT_EVENT_DISCRIMINATOR,
  CREDIT_ROOT_SEED, CREDIT_EVENT_SEED, CREDIT_ROOT_SIZE, CREDIT_EVENT_SIZE,
} from "../src/constants/index.js";

describe("credit-identity constants", () => {
  it("ix discriminators equal the anchor sighash", () => {
    expect(Array.from(DISCRIMINATORS.establish_credit_root))
      .toEqual(Array.from(sha256("global:establish_credit_root").slice(0, 8)));
    expect(Array.from(DISCRIMINATORS.record_credit_event))
      .toEqual(Array.from(sha256("global:record_credit_event").slice(0, 8)));
  });
  it("account discriminators equal the anchor account sighash", () => {
    expect(Array.from(CREDIT_ROOT_DISCRIMINATOR))
      .toEqual(Array.from(sha256("account:CreditRoot").slice(0, 8)));
    expect(Array.from(CREDIT_EVENT_DISCRIMINATOR))
      .toEqual(Array.from(sha256("account:CreditEvent").slice(0, 8)));
  });
  it("pins seeds + sizes", () => {
    expect(CREDIT_ROOT_SEED).toBe("credit_root");
    expect(CREDIT_EVENT_SEED).toBe("credit_event");
    expect(CREDIT_ROOT_SIZE).toBe(58);
    expect(CREDIT_EVENT_SIZE).toBe(99);
  });
});
