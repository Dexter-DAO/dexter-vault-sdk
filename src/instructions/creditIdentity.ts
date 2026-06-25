// src/instructions/creditIdentity.ts
import { PublicKey, TransactionInstruction, SystemProgram } from "@solana/web3.js";
import { DEXTER_VAULT_PROGRAM_ID, DISCRIMINATORS, INTERIM_ROOT_AUTHORITY } from "../constants/index.js";
import { deriveCreditRootPda, deriveCreditEventPda } from "../credit/derive.js";

const WORLD_ID_ROOT_SEED = "world_id_root";
function rootCachePda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from(WORLD_ID_ROOT_SEED)], programId)[0];
}
function fixed(b: Uint8Array, n: number, name: string): Buffer {
  if (b.length !== n) throw new Error(`${name} must be ${n} bytes, got ${b.length}`);
  return Buffer.from(b);
}

export interface EstablishCreditRootParams {
  proofA: Uint8Array; proofB: Uint8Array; proofC: Uint8Array; publicInputs: Uint8Array[]; payer: PublicKey;
}
export function buildEstablishCreditRootInstruction(p: EstablishCreditRootParams): TransactionInstruction {
  if (p.publicInputs.length !== 15) throw new Error("publicInputs must be 15 × 32 bytes");
  const nullifier = p.publicInputs[0]!;
  const piBuf = Buffer.concat(p.publicInputs.map((x, i) => fixed(x, 32, `publicInputs[${i}]`)));
  const data = Buffer.concat([
    Buffer.from(DISCRIMINATORS.establish_credit_root),
    fixed(p.proofA, 64, "proofA"), fixed(p.proofB, 128, "proofB"), fixed(p.proofC, 64, "proofC"), piBuf,
  ]);
  const [creditRoot] = deriveCreditRootPda(nullifier);
  return new TransactionInstruction({
    programId: DEXTER_VAULT_PROGRAM_ID,
    keys: [
      { pubkey: rootCachePda(DEXTER_VAULT_PROGRAM_ID), isSigner: false, isWritable: false },
      { pubkey: creditRoot, isSigner: false, isWritable: true },
      { pubkey: p.payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export interface EstablishCreditRootTrustedParams {
  /** The off-chain-verified World ID nullifier (32 bytes) — the CreditRoot PDA
   *  seed AND the stored key. (For a v3 Orb proof checked off-chain.) */
  nullifier: Uint8Array;
  /** Trusted operator + rent payer + the ONLY valid signer. Defaults to
   *  INTERIM_ROOT_AUTHORITY; the on-chain handler rejects any other key. */
  authority?: PublicKey;
}

/**
 * Build `establish_credit_root_trusted` — the authority-attested (off-chain
 * verified) personhood → CreditRoot path. This is the instruction that actually
 * rooted the first mainnet Orb; it had no SDK builder, so the rooting was a
 * one-off ad-hoc ix (open-D punch-list #1). Sibling of
 * buildEstablishCreditRootInstruction (the trustless groth16 path): it writes
 * the SAME CreditRoot PDA (seed = nullifier), byte-identical layout, with
 * `version = 2` marking the trusted attestation. NO on-chain groth16, NO
 * root-cache account — just the operator's signature.
 *
 * Accounts (per IDL — NOTE only 3, no root_cache):
 *   [0] credit_root      (writable)         — PDA [credit_root, nullifier], init
 *   [1] authority        (writable, signer) — INTERIM_ROOT_AUTHORITY, pays rent
 *   [2] system_program
 */
export function buildEstablishCreditRootTrustedInstruction(
  p: EstablishCreditRootTrustedParams,
): TransactionInstruction {
  const nullifier = fixed(p.nullifier, 32, "nullifier");
  const authority = p.authority ?? INTERIM_ROOT_AUTHORITY;
  const data = Buffer.concat([
    Buffer.from(DISCRIMINATORS.establish_credit_root_trusted),
    nullifier,
  ]);
  const [creditRoot] = deriveCreditRootPda(p.nullifier);
  return new TransactionInstruction({
    programId: DEXTER_VAULT_PROGRAM_ID,
    keys: [
      { pubkey: creditRoot, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export interface RecordCreditEventParams {
  nullifier: Uint8Array; eventCount: bigint; vault: PublicKey; agentId: Uint8Array; kind: number; amount: bigint; payer: PublicKey;
}
export function buildRecordCreditEventInstruction(p: RecordCreditEventParams): TransactionInstruction {
  const agent = fixed(p.agentId, 32, "agentId");
  const tail = Buffer.alloc(1 + 8);
  tail.writeUInt8(p.kind & 0xff, 0);
  tail.writeBigUInt64LE(p.amount, 1);
  const data = Buffer.concat([Buffer.from(DISCRIMINATORS.record_credit_event), agent, tail]);
  const [creditRoot] = deriveCreditRootPda(p.nullifier);
  const [creditEvent] = deriveCreditEventPda(p.nullifier, p.eventCount);
  return new TransactionInstruction({
    programId: DEXTER_VAULT_PROGRAM_ID,
    keys: [
      { pubkey: creditRoot, isSigner: false, isWritable: true },
      { pubkey: p.vault, isSigner: false, isWritable: false },
      { pubkey: creditEvent, isSigner: false, isWritable: true },
      { pubkey: p.payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}
