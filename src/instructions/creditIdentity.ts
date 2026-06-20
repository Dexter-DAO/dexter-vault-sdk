// src/instructions/creditIdentity.ts
import { PublicKey, TransactionInstruction, SystemProgram } from "@solana/web3.js";
import { DEXTER_VAULT_PROGRAM_ID, DISCRIMINATORS } from "../constants/index.js";
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
