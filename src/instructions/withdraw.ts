/**
 * Withdrawal-path vault instructions.
 *   - request_withdrawal — passkey signs; mutates pending_withdrawal
 *   - finalize_withdrawal — passkey signs; Swig role 1 drives the SPL transfer
 *   - force_release — buyer's passkey clears a stuck count after the grace window
 *
 * All three are passkey-signed and require a secp256r1 precompile sibling.
 * finalize_withdrawal and force_release additionally interact with Swig's
 * ProgramExec validator (role 1 marker = finalize_withdrawal discriminator).
 */

import {
  PublicKey,
  TransactionInstruction,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from '@solana/web3.js';

import {
  DEXTER_VAULT_PROGRAM_ID,
  SWIG_PROGRAM_ID,
  DISCRIMINATORS,
} from '../constants/index.js';

/** Borsh `Vec<u8>` = u32-LE length prefix + bytes. */
function encodeBytesVec(buf: Uint8Array): Buffer {
  const out = Buffer.alloc(4 + buf.length);
  out.writeUInt32LE(buf.length, 0);
  Buffer.from(buf).copy(out, 4);
  return out;
}

function encodeU64(value: bigint): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(value, 0);
  return out;
}
function encodeI64(value: bigint): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigInt64LE(value, 0);
  return out;
}
function encodePubkey(key: PublicKey): Buffer {
  return Buffer.from(key.toBytes());
}

/**
 * Derive the canonical Swig wallet-address PDA: seeds = ["swig-wallet-address", swig_state].
 * The vault program enforces this derivation; we recompute client-side
 * so we can pass it as account[1] of finalize_withdrawal / settle_tab_voucher.
 */
export function deriveSwigWalletAddress(swigAddress: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('swig-wallet-address'), swigAddress.toBuffer()],
    SWIG_PROGRAM_ID,
  );
  return pda;
}

// ── request_withdrawal ────────────────────────────────────────────────────

export interface RequestWithdrawalParams {
  vaultPda: PublicKey;
  amount: bigint;
  destination: PublicKey;
  signedAt: bigint;
  clientDataJSON: Uint8Array;
  authenticatorData: Uint8Array;
}

export function buildRequestWithdrawalInstruction(
  p: RequestWithdrawalParams,
): TransactionInstruction {
  const argsBuf = Buffer.concat([
    encodeU64(p.amount),
    encodePubkey(p.destination),
    encodeI64(p.signedAt),
    encodeBytesVec(p.clientDataJSON),
    encodeBytesVec(p.authenticatorData),
  ]);
  const data = Buffer.concat([Buffer.from(DISCRIMINATORS.request_withdrawal), argsBuf]);

  return new TransactionInstruction({
    programId: DEXTER_VAULT_PROGRAM_ID,
    keys: [
      { pubkey: p.vaultPda, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ── finalize_withdrawal ───────────────────────────────────────────────────

export interface FinalizeWithdrawalParams {
  vaultPda: PublicKey;
  swigAddress: PublicKey;
  /**
   * The swig wallet's USDC ATA — read live on-chain for the Phase 1 reservation
   * gate (isWritable false; the transfer is the separate Swig::SignV2 ix).
   */
  vaultUsdcAta: PublicKey;
  /**
   * The vault's welded PrincipalNode. REQUIRED iff the vault is welded
   * (`vault.node != default`) so finalize_withdrawal can reserve the node's full
   * credit liability (`subtree_draw`). Pass null/undefined for a plain non-credit
   * vault — the builder emits the program-id None sentinel (Anchor optional acct).
   */
  node?: PublicKey | null;
  clientDataJSON: Uint8Array;
  authenticatorData: Uint8Array;
}

/**
 * Account ordering MUST match the on-chain Anchor struct:
 *   [0] swig                — required by Swig's ProgramExec validator + bound via Anchor `address`
 *   [1] swig_wallet_address — canonical PDA under the Swig program
 *   [2] vault               — the vault PDA being mutated
 *   [3] vault_usdc_ata      — swig wallet's USDC ATA, read for the reservation gate (read-only)
 *   [4] node                — OPTIONAL: the welded PrincipalNode (credit-liability pin); program-id = None
 *   [5] instructions_sysvar — for the secp256r1 precompile sibling lookup
 */
export function buildFinalizeWithdrawalInstruction(
  p: FinalizeWithdrawalParams,
): TransactionInstruction {
  const argsBuf = Buffer.concat([
    encodeBytesVec(p.clientDataJSON),
    encodeBytesVec(p.authenticatorData),
  ]);
  const data = Buffer.concat([Buffer.from(DISCRIMINATORS.finalize_withdrawal), argsBuf]);
  const swigWalletAddress = deriveSwigWalletAddress(p.swigAddress);

  return new TransactionInstruction({
    programId: DEXTER_VAULT_PROGRAM_ID,
    keys: [
      { pubkey: p.swigAddress, isSigner: false, isWritable: false },
      { pubkey: swigWalletAddress, isSigner: false, isWritable: false },
      { pubkey: p.vaultPda, isSigner: false, isWritable: true },
      { pubkey: p.vaultUsdcAta, isSigner: false, isWritable: false },
      // Anchor optional account: the program id itself signals None (unwelded vault).
      { pubkey: p.node ?? DEXTER_VAULT_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ── force_release ─────────────────────────────────────────────────────────

export interface ForceReleaseParams {
  vaultPda: PublicKey;
  clientDataJSON: Uint8Array;
  authenticatorData: Uint8Array;
}

/**
 * BUYER-controlled: the buyer's passkey clears a stuck count after the grace
 * period. Op message is "force_release" || swig_address.
 */
export function buildForceReleaseInstruction(p: ForceReleaseParams): TransactionInstruction {
  const argsBuf = Buffer.concat([
    encodeBytesVec(p.clientDataJSON),
    encodeBytesVec(p.authenticatorData),
  ]);
  const data = Buffer.concat([Buffer.from(DISCRIMINATORS.force_release), argsBuf]);

  return new TransactionInstruction({
    programId: DEXTER_VAULT_PROGRAM_ID,
    keys: [
      { pubkey: p.vaultPda, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    ],
    data,
  });
}
