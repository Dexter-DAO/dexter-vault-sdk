/**
 * prove_passkey — read-only proof-of-control; the Solana analogue of EIP-1271.
 *
 * Verbatim port of dexter-api/src/vault/instructions.ts:406-422.
 *
 * Proves the passkey controlling `vaultPda` authorized `challenge`, mutating
 * NOTHING. The on-chain handler reconstructs the op message as
 * "siwx_login" || challenge and verifies it via the SIMD-0075 secp256r1
 * precompile sibling (which MUST precede this instruction). A verifier treats a
 * passing `simulateTransaction([secp256r1_verify, prove_passkey], {sigVerify:false})`
 * (err === null) as proof of control. The `vault` account is read-only and
 * non-signer — no Dexter key, no fee, no state change.
 */

import {
  PublicKey,
  TransactionInstruction,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from '@solana/web3.js';

import { DEXTER_VAULT_PROGRAM_ID, DISCRIMINATORS } from '../constants/index.js';

function encodeBytesVec(buf: Uint8Array): Buffer {
  const out = Buffer.alloc(4 + buf.length);
  out.writeUInt32LE(buf.length, 0);
  Buffer.from(buf).copy(out, 4);
  return out;
}

function encodeFixedBytes(buf: Uint8Array, len: number): Buffer {
  if (buf.length !== len) {
    throw new Error(`expected ${len} bytes, got ${buf.length}`);
  }
  return Buffer.from(buf);
}

export interface ProvePasskeyParams {
  vaultPda: PublicKey;
  challenge: Uint8Array; // 32 bytes — what the passkey proves control over
  clientDataJSON: Uint8Array; // WebAuthn ceremony over "siwx_login" || challenge
  authenticatorData: Uint8Array;
}

export function buildProvePasskeyInstruction(p: ProvePasskeyParams): TransactionInstruction {
  const argsBuf = Buffer.concat([
    encodeFixedBytes(p.challenge, 32),
    encodeBytesVec(p.clientDataJSON),
    encodeBytesVec(p.authenticatorData),
  ]);
  const data = Buffer.concat([Buffer.from(DISCRIMINATORS.prove_passkey), argsBuf]);

  return new TransactionInstruction({
    programId: DEXTER_VAULT_PROGRAM_ID,
    keys: [
      { pubkey: p.vaultPda, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    ],
    data,
  });
}
