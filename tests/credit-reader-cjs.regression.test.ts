/**
 * Regression: fetchCreditEvents must be CJS-safe.
 *
 * The gPA memcmp filter base58-encodes the 32-byte nullifier. The original
 * code used `bs58.encode(...)`. Under CJS, bs58@6 only exposes `encode` on
 * `.default`, so tsup's bundled `import_bs58.default.encode` resolved
 * undefined and `fetchCreditEvents` threw the moment it reached the filter —
 * the ESM build worked, the CJS build was broken for every CJS consumer.
 *
 * The fix base58-encodes the nullifier via `new PublicKey(nullifier).toBase58()`
 * (CJS-safe, no runtime bs58 in the fetch path — matching the rest of the SDK).
 *
 * This test drives the nullifier->base58 path through the BUILT CJS bundle
 * (dist/reader/index.cjs) with a mocked connection so no live RPC is needed.
 * It exercises exactly the line that used to throw. Against the old
 * `bs58.encode` code, requiring the built CJS bundle and calling
 * fetchCreditEvents would throw "import_bs58.default.encode is not a function".
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { PublicKey } from "@solana/web3.js";

const require = createRequire(import.meta.url);
const CJS_BUNDLE = resolve(__dirname, "../dist/reader/index.cjs");

// Fixed nullifier (all 0x09) with its known-correct base58 encoding.
const FIXED_NULLIFIER = new Uint8Array(32).fill(9);
const FIXED_NULLIFIER_B58 = "cGfHiC6Kgg3FpFZvgwGcswsCRtp4aBP2fzuXRQPizuN";

describe("fetchCreditEvents CJS-safe base58 (regression)", () => {
  it("known nullifier encodes to the same base58 via PublicKey as via bs58", () => {
    // The encoding equivalence that makes the bs58->PublicKey swap correct.
    expect(new PublicKey(FIXED_NULLIFIER).toBase58()).toBe(FIXED_NULLIFIER_B58);
  });

  it("requires the built CJS bundle and drives the base58 filter path without throwing", async () => {
    if (!existsSync(CJS_BUNDLE)) {
      throw new Error(
        `CJS bundle missing at ${CJS_BUNDLE} — run \`npm run build\` before this test`,
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const cjs = require(CJS_BUNDLE) as {
      fetchCreditEvents: (
        connection: unknown,
        nullifier: Uint8Array,
      ) => Promise<unknown[]>;
    };

    expect(typeof cjs.fetchCreditEvents).toBe("function");

    // Capture the memcmp filter the reader builds — proves we reached and
    // executed the base58 encoding of the nullifier (the line that used to
    // throw under CJS) and that it produced the correct bytes.
    let capturedFilters: any[] | undefined;
    const fakeConnection = {
      getProgramAccounts: async (_programId: unknown, opts: any) => {
        capturedFilters = opts.filters;
        return []; // no accounts; we only care that we got this far
      },
    };

    const events = await cjs.fetchCreditEvents(fakeConnection, FIXED_NULLIFIER);
    expect(events).toEqual([]);

    // The nullifier memcmp filter must carry the correct base58 string.
    const nullifierFilter = capturedFilters?.find(
      (f) => f?.memcmp?.bytes === FIXED_NULLIFIER_B58,
    );
    expect(nullifierFilter).toBeDefined();
  });
});
