/**
 * register_session_key — authorize a session ed25519 key under a vault.
 *
 * V6 multi-session layout (data encoding unchanged from V5).
 *
 * Accounts (in declaration order — Anchor is strict):
 *   0. [writable]            vault                — the Vault PDA being mutated
 *   1. [readonly]            vault_usdc_ata       — swig wallet's USDC ATA, read live
 *                                                   for the overcommit gate
 *   2. [readonly]            swig                 — the vault's swig account (== vault.swig_address)
 *   3. [readonly]            swig_wallet_address  — canonical PDA under the Swig program (derived)
 *   4. [readonly]            instructions_sysvar  — address-constrained
 *   5. [writable]            session              — init_if_needed PDA
 *                                                   [b"session", vault, allowed_counterparty]
 *   6. [signer, writable]    payer                — funds the session PDA rent
 *   7. [readonly]            system_program
 *   ... remaining accounts: every OTHER SessionAccount PDA with version != 0
 *       (live AND expired-unswept) of this vault (target excluded), deduped,
 *       sorted strict-ascending by raw bytes,
 *       all writable — see src/session/fetch.ts for the full sibling contract.
 *
 * Args (Borsh-serialized after the 8-byte discriminator):
 *   session_pubkey: [u8; 32]
 *   max_amount: u64
 *   expires_at: i64
 *   allowed_counterparty: Pubkey (32 bytes)
 *   nonce: u32
 *   max_revolving_capacity: u64
 *   client_data_json: Vec<u8>
 *   authenticator_data: Vec<u8>
 */

import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';

import {
  DEXTER_VAULT_PROGRAM_ID,
  INSTRUCTIONS_SYSVAR_ID,
  DISCRIMINATORS,
} from '../constants/index.js';
import { deriveSessionPda, buildSiblingAccountMetas } from '../session/index.js';
import { deriveSwigWalletAddress } from './withdraw.js';

function encodeU64LE(value: bigint): Uint8Array {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setBigUint64(0, value, true);
  return buf;
}

function encodeI64LE(value: bigint): Uint8Array {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setBigInt64(0, value, true);
  return buf;
}

function encodeU32LE(value: number): Uint8Array {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, value >>> 0, true);
  return buf;
}

function encodeVecU8(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length >>> 0, true);
  out.set(bytes, 4);
  return out;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export interface BuildRegisterSessionKeyArgs {
  vaultPda: PublicKey;
  sessionPubkey: Uint8Array;        // 32 bytes, ed25519
  maxAmount: bigint;
  expiresAt: bigint;                 // i64 seconds
  allowedCounterparty: PublicKey;
  nonce: number;                     // u32
  maxRevolvingCapacity: bigint;      // u64, must be > 0 (program enforces)
  /** The vault's swig account (== vault.swig_address). The builder derives
   *  swig_wallet_address from this via deriveSwigWalletAddress(). */
  swigAddress: PublicKey;
  /** Swig wallet's USDC ATA — read live on-chain for the overcommit gate.
   *  Pass `null` for a credit-only vault whose ATA does not exist on-chain:
   *  own-USDC is then counted as 0 and backing is the available standby credit
   *  alone (the program receives Anchor's optional-account None sentinel).
   *  Use {@link resolveVaultUsdcAta} to derive-and-probe this in one call. */
  vaultUsdcAta: PublicKey | null;
  /** V6: funds the session PDA rent on first creation (signer, writable). */
  payer: PublicKey;
  /** V6: EVERY OTHER version!=0 SessionAccount PDA of this vault (live AND
   *  expired-unswept), target excluded — fetch FRESH via
   *  fetchVaultSessionAccounts immediately before building. The builder
   *  excludes/dedups/sorts and marks all writable. Wrong/stale set → the
   *  program reverts (IncompleteSessionSet / SessionAccountsNotSorted /
   *  SessionWouldOvercommitVault…). See src/session/fetch.ts for the contract.
   *  Happy path: sessionPdasOf(await fetchVaultSessionAccounts(conn, vaultPda)). */
  siblingSessionPdas: PublicKey[];
  /** V7 (the node-backed credit gate): the vault's welded PrincipalNode
   *  (== vault.node), appended read-only. The program detects it by
   *  discriminator — it never joins the sibling ordering — and counts its
   *  pro-forma drawable credit as session backing, so a credit-backed vault
   *  can open a session past its own USDC. The key MUST equal the link-once
   *  vault.node (anything else reverts SessionAccountForeign). Omit (or null)
   *  for own-USDC-only backing — the pre-V7 behavior, and the only valid
   *  shape against a pre-V7 program (which treats the node as a sibling and
   *  reverts). */
  weldedNodePda?: PublicKey | null;
  clientDataJSON: Uint8Array;        // WebAuthn ceremony output
  authenticatorData: Uint8Array;     // WebAuthn ceremony output
}

export function buildRegisterSessionKeyInstruction(
  args: BuildRegisterSessionKeyArgs,
): TransactionInstruction {
  if (args.sessionPubkey.length !== 32) {
    throw new Error(`sessionPubkey must be 32 bytes, got ${args.sessionPubkey.length}`);
  }

  const data = concatBytes(
    DISCRIMINATORS.register_session_key,
    args.sessionPubkey,
    encodeU64LE(args.maxAmount),
    encodeI64LE(args.expiresAt),
    args.allowedCounterparty.toBytes(),
    encodeU32LE(args.nonce),
    encodeU64LE(args.maxRevolvingCapacity),
    encodeVecU8(args.clientDataJSON),
    encodeVecU8(args.authenticatorData),
  );

  const swigWalletAddress = deriveSwigWalletAddress(args.swigAddress);
  const [sessionPda] = deriveSessionPda(args.vaultPda, args.allowedCounterparty);
  const siblingMetas = buildSiblingAccountMetas(args.siblingSessionPdas, sessionPda);

  return new TransactionInstruction({
    keys: [
      { pubkey: args.vaultPda, isSigner: false, isWritable: true },
      // Anchor optional-account None convention: a credit-only vault has no
      // USDC ATA, so we pass the program-ID sentinel (readonly, non-signer);
      // the program then counts own-USDC as 0. A real ATA is passed unchanged.
      { pubkey: args.vaultUsdcAta ?? DEXTER_VAULT_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: args.swigAddress, isSigner: false, isWritable: false },
      { pubkey: swigWalletAddress, isSigner: false, isWritable: false },
      { pubkey: INSTRUCTIONS_SYSVAR_ID, isSigner: false, isWritable: false },
      { pubkey: sessionPda, isSigner: false, isWritable: true },
      { pubkey: args.payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ...siblingMetas,
      // V7 node-backed credit gate: appended AFTER the siblings (position is
      // free — discriminator-detected), read-only.
      ...(args.weldedNodePda
        ? [{ pubkey: args.weldedNodePda, isSigner: false, isWritable: false }]
        : []),
    ],
    programId: DEXTER_VAULT_PROGRAM_ID,
    data: Buffer.from(data),
  });
}
