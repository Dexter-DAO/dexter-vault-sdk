// tests/e2e/personhood-loop.e2e.test.ts
//
// SDK-driven fixture E2E: proves the personhood credit -> ledger loop is
// drivable entirely through the PUBLISHED @dexterai/vault surface (the contract
// the facilitator + admin console consume), not the program's Anchor bindings.
//
// Mirrors the step order of dexter-vault/tests/world-id-credit-root.ts but every
// on-chain write/read goes through an SDK export:
//   establish_credit_root -> welded vault -> record_credit_event -> readback.
//
// SKIPS itself unless DEXTER_RPC / FIXTURE_DIR / PAYER_KEYPAIR are all set, so a
// validator-less CI stays green. No real World ID proof — fixture only.
//
// Proof-shape note: the committed fixture is snarkjs-RAW (proof.json has
// pi_a/pi_b/pi_c as projective decimal-string limbs, NOT pre-prepared byte
// arrays). We therefore MIRROR dexter-vault/tests/helpers/world-id.ts
// loadFixtureProofArgs EXACTLY: proof_a = x ‖ (-y mod P), proof_b limb-reordered
// to x_c1 ‖ x_c0 ‖ y_c1 ‖ y_c0, proof_c = x ‖ y (not negated). public.json is
// 15 decimal field elements -> big-endian 32-byte each (public[0] = nullifier).

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { buildEstablishCreditRootInstruction, buildRecordCreditEventInstruction } from "../../src/instructions/creditIdentity.js";
import { makeWeldedVaultAgentId, buildWeldedVaultInstruction, deriveWeldedVaultPda } from "../../src/credit/weldedVault.js";
import { deriveIdentityClaim } from "../../src/credit/derive.js";
import { readCreditRoot, fetchCreditEvents } from "../../src/reader/creditRootReader.js";

const RPC = process.env.DEXTER_RPC;
const DIR = process.env.FIXTURE_DIR;
const KP = process.env.PAYER_KEYPAIR;
const run = RPC && DIR && KP ? describe : describe.skip;

// bn254 base field prime P — used to negate proof_a's y-coordinate
// (groth16-solana folds `-A` into the pairing). Same constant as the Rust
// host KAT in programs/dexter-vault/src/verify/groth16.rs.
const P =
  21888242871839275222246405745257275088696311157297823662689037894645226208583n;

/** Decimal field-element string -> 32-byte BIG-ENDIAN Uint8Array. */
function dec2be32(s: string): Uint8Array {
  const hex = BigInt(s).toString(16).padStart(64, "0");
  if (hex.length > 64) throw new Error(`field element exceeds 32 bytes: ${s}`);
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

interface SnarkjsProof {
  pi_a: string[]; // [x, y, 1]
  pi_b: string[][]; // [[x_c0, x_c1], [y_c0, y_c1], [1, 0]]
  pi_c: string[]; // [x, y, 1]
}

/** proof_a (G1, NEGATED): x ‖ (-y mod P). */
function prepProofA(pi_a: string[]): Uint8Array {
  const x = pi_a[0];
  const y = pi_a[1];
  if (x === undefined || y === undefined) throw new Error("pi_a missing limbs");
  const negY = ((P - BigInt(y)) % P).toString();
  return concatBytes(dec2be32(x), dec2be32(negY));
}

/** proof_b (G2): x_c1 ‖ x_c0 ‖ y_c1 ‖ y_c0 (snarkjs stores [[x_c0,x_c1],[y_c0,y_c1]]). */
function prepProofB(pi_b: string[][]): Uint8Array {
  const xc = pi_b[0];
  const yc = pi_b[1];
  if (xc === undefined || yc === undefined) throw new Error("pi_b missing rows");
  const xc0 = xc[0];
  const xc1 = xc[1];
  const yc0 = yc[0];
  const yc1 = yc[1];
  if (xc0 === undefined || xc1 === undefined || yc0 === undefined || yc1 === undefined) {
    throw new Error("pi_b missing limbs");
  }
  return concatBytes(dec2be32(xc1), dec2be32(xc0), dec2be32(yc1), dec2be32(yc0));
}

/** proof_c (G1, NOT negated): x ‖ y. */
function prepProofC(pi_c: string[]): Uint8Array {
  const x = pi_c[0];
  const y = pi_c[1];
  if (x === undefined || y === undefined) throw new Error("pi_c missing limbs");
  return concatBytes(dec2be32(x), dec2be32(y));
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

run("personhood loop (SDK-driven, fixture)", () => {
  // NOTE: keep the describe-callback body free of side effects. `describe.skip`
  // still EXECUTES this callback (to register the skipped test), so any
  // top-level `new Connection(...)` / file read would throw on a validator-less
  // CI box where the env vars are unset. All setup lives inside `it`.
  it("establish -> welded vault -> record -> readback", async () => {
    const conn = new Connection(RPC!, "confirmed");
    const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(KP!, "utf8"))));

    const proof = JSON.parse(fs.readFileSync(path.join(DIR!, "proof.json"), "utf8")) as SnarkjsProof;
    const pub = JSON.parse(fs.readFileSync(path.join(DIR!, "public.json"), "utf8")) as string[];
    if (pub.length !== 15) throw new Error(`fixture nPublic mismatch: ${pub.length} != 15`);

    const publicInputs = pub.map(dec2be32); // 15 × 32
    const nullifier = publicInputs[0];
    if (nullifier === undefined) throw new Error("public.json has no nullifier");

    // NOTE: the program must already have its interim root posted
    // (post_interim_root with public.json[6] = R_test); do that via the
    // dexter-vault harness. See tests/e2e/README.md.
    const estIx = buildEstablishCreditRootInstruction({
      proofA: prepProofA(proof.pi_a),
      proofB: prepProofB(proof.pi_b),
      proofC: prepProofC(proof.pi_c),
      publicInputs,
      payer: payer.publicKey,
    });
    await sendAndConfirmTransaction(
      conn,
      new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
        .add(estIx),
      [payer],
    );

    // Fresh Flow-B welded vault: secret agent_id, identity_claim = SHA256(nullifier ‖ agent_id).
    const agentId = makeWeldedVaultAgentId();
    const claim = deriveIdentityClaim(nullifier, agentId);
    const passkey = Uint8Array.from([0x02, ...Array(32).fill(1)]); // 33-byte SEC1 compressed
    const vaultIx = buildWeldedVaultInstruction({
      identityClaim: claim,
      passkeyPubkey: passkey,
      coolingOffSeconds: 0,
      payer: payer.publicKey,
      dexterAuthority: payer.publicKey,
    });
    await sendAndConfirmTransaction(conn, new Transaction().add(vaultIx), [payer]);
    const [vaultPda] = deriveWeldedVaultPda(claim);

    // Ledger starts empty.
    const root0 = await readCreditRoot(conn, nullifier);
    expect(root0?.eventCount).toBe(0n);

    // Wire one lifecycle event to the ledger through the SDK.
    const recIx = buildRecordCreditEventInstruction({
      nullifier,
      eventCount: 0n,
      vault: vaultPda,
      agentId,
      kind: 1,
      amount: 500_000n,
      payer: payer.publicKey,
    });
    await sendAndConfirmTransaction(conn, new Transaction().add(recIx), [payer]);

    // Readback through the SDK readers.
    const root1 = await readCreditRoot(conn, nullifier);
    expect(root1?.eventCount).toBe(1n);

    const events = await fetchCreditEvents(conn, nullifier);
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev).toBeDefined();
    expect(ev!.amount).toBe(500_000n);
    expect(ev!.kind).toBe(1);
    expect(ev!.vault).toBe(vaultPda.toBase58());
  });
});
