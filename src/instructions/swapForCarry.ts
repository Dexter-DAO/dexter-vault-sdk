/**
 * swap_for_carry / finish_swap — the carry-engine swap leg (yield launch, R5).
 *
 * The delta-sandwich bracket, fork-proven 17/17 (14 legacy + c8b welded) and
 * LIVE on mainnet since 2026-07-18:
 *
 *   [CB] [secp256r1 precompile] [swap_for_carry] [Swig::SignV2(route)] [finish_swap]
 *
 * This module owns the INSTRUCTION ASSEMBLY (mirrors finalizeBundle.ts for
 * withdrawals) so no consumer ever hand-rolls the bytes:
 *   - buildSwapForCarryMessage: the 111-byte passkey op message. The WebAuthn
 *     challenge MUST be sha256(op_msg) (program-enforced).
 *   - buildSwapForCarryInstruction / buildFinishSwapInstruction: byte-exact
 *     Anchor instructions per the deployed IDL.
 *   - wrapRouteWithSwapSignV2: the Swig SignV2 wrap under the role-9
 *     swap_for_carry ProgramExec marker (marker-matched, never index-matched —
 *     ceremony-backfilled vaults carry role 9 at a variable index).
 *
 * Landmines carried from the GATE-1 review (do not relearn these):
 *   - Routes MUST be ExactIn; finish_swap requires input spent EXACTLY
 *     amount_in (third-token-siphon guard) — a non-ExactIn route reverts.
 *   - min_out is the USER's signed slippage bound. The caller sets it tight;
 *     a loose min_out is a sandwich invitation the program cannot see.
 *   - expiry_slot must be within MAX_SWAP_INTENT_HORIZON_SLOTS (1000) of the
 *     tip; sign a much tighter window in practice.
 *   - The SignV2 wrap hard-requires the marker instruction as the single
 *     preInstruction (ProgramExec contract); we hand-place our own byte-
 *     identical swap ix in the tx and use ONLY the returned SignV2.
 */
import {
  Connection,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  TransactionInstruction,
} from '@solana/web3.js';
import { fetchSwig, getSignInstructions } from '@swig-wallet/kit';
import { address as kitAddress } from '@solana/kit';
import { DEXTER_VAULT_PROGRAM_ID, DISCRIMINATORS } from '../constants/index.js';
import { SWIG_PROGRAM_EXEC_PREFIX_SWAP_FOR_CARRY } from './swigBundle.js';
import { findProgramExecRoleId } from '../factoring/instantPayout.js';
import { kitInstructionsToWeb3, getRpc } from '../factoring/kitBridge.js';

export const SWAP_DIRECTION_BUY = 0;
export const SWAP_DIRECTION_SELL = 1;

/** Program cap on intent lifetime (slots past the tip). Sign tighter. */
export const MAX_SWAP_INTENT_HORIZON_SLOTS = 1000n;

const OP_TAG = 'swap_for_carry'; // 14 bytes

function encodeBytesVec(buf: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(buf.length, 0);
  return Buffer.concat([len, Buffer.from(buf)]);
}

function u64le(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v, 0);
  return b;
}

export function deriveSwapBracketPda(
  vault: PublicKey,
  programId: PublicKey = DEXTER_VAULT_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('swap_bracket'), vault.toBuffer()],
    programId,
  );
}

export interface SwapIntent {
  vault: PublicKey;
  /** SWAP_DIRECTION_BUY (USDC -> base) or SWAP_DIRECTION_SELL. */
  direction: number;
  /** Exact input the route must spend (ExactIn — program-enforced). */
  amountIn: bigint;
  /** The user's signed slippage floor — set TIGHT. */
  minOut: bigint;
  baseMint: PublicKey;
  /** Must equal the bracket's current nonce at execution. */
  nonce: bigint;
  /** Last valid execution slot; within MAX_SWAP_INTENT_HORIZON_SLOTS of tip. */
  expirySlot: bigint;
}

/**
 * The 111-byte op message the passkey endorses. MUST mirror swap_for_carry.rs
 * byte-exactly: "swap_for_carry" || vault(32) || direction(1) || amount_in(8 LE)
 * || min_out(8 LE) || base_mint(32) || nonce(8 LE) || expiry_slot(8 LE).
 * Vault binding right after the tag is the GATE-1 cross-vault-replay fix.
 * The WebAuthn challenge is sha256 of THESE bytes.
 */
export function buildSwapForCarryMessage(i: SwapIntent): Uint8Array {
  const out = Buffer.concat([
    Buffer.from(OP_TAG, 'ascii'),
    i.vault.toBuffer(),
    Buffer.from([i.direction]),
    u64le(i.amountIn),
    u64le(i.minOut),
    i.baseMint.toBuffer(),
    u64le(i.nonce),
    u64le(i.expirySlot),
  ]);
  if (out.length !== 111) {
    throw new Error(`swap_for_carry op message must be 111 bytes, got ${out.length}`);
  }
  return Uint8Array.from(out);
}

export interface BuildSwapForCarryIxParams {
  intent: SwapIntent;
  /** WebAuthn evidence; clientDataJSON.challenge must be sha256(op_msg). */
  clientDataJSON: Uint8Array;
  authenticatorData: Uint8Array;
  swigAddress: PublicKey;
  swigWalletAddress: PublicKey;
  assetConfig: PublicKey;
  vaultUsdcAta: PublicKey;
  vaultBaseAta: PublicKey;
  graphConfig: PublicKey;
  /** Transaction fee payer (writable signer at the program's account 9). */
  feePayer: PublicKey;
  programId?: PublicKey;
}

/** Byte-exact swap_for_carry instruction (accounts per deployed IDL). */
export function buildSwapForCarryInstruction(
  p: BuildSwapForCarryIxParams,
): TransactionInstruction {
  const programId = p.programId ?? DEXTER_VAULT_PROGRAM_ID;
  const [bracket] = deriveSwapBracketPda(p.intent.vault, programId);
  const data = Buffer.concat([
    Buffer.from(DISCRIMINATORS.swap_for_carry),
    Buffer.from([p.intent.direction]),
    u64le(p.intent.amountIn),
    u64le(p.intent.minOut),
    u64le(p.intent.nonce),
    u64le(p.intent.expirySlot),
    encodeBytesVec(p.clientDataJSON),
    encodeBytesVec(p.authenticatorData),
  ]);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: p.swigAddress, isSigner: false, isWritable: false },
      { pubkey: p.swigWalletAddress, isSigner: false, isWritable: false },
      { pubkey: p.intent.vault, isSigner: false, isWritable: false },
      { pubkey: bracket, isSigner: false, isWritable: true },
      { pubkey: p.assetConfig, isSigner: false, isWritable: false },
      { pubkey: p.intent.baseMint, isSigner: false, isWritable: false },
      { pubkey: p.vaultUsdcAta, isSigner: false, isWritable: false },
      { pubkey: p.vaultBaseAta, isSigner: false, isWritable: false },
      { pubkey: p.graphConfig, isSigner: false, isWritable: false },
      { pubkey: p.feePayer, isSigner: true, isWritable: true },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export interface BuildFinishSwapIxParams {
  vault: PublicKey;
  vaultUsdcAta: PublicKey;
  vaultBaseAta: PublicKey;
  /** REQUIRED when the vault is welded (vault.node set) — c8b-2 proves the
   *  program rejects null with CreditNodeRequired. Pass null for plain vaults. */
  node: PublicKey | null;
  graphConfig: PublicKey;
  programId?: PublicKey;
}

/** Byte-exact finish_swap instruction (accounts per deployed IDL). */
export function buildFinishSwapInstruction(
  p: BuildFinishSwapIxParams,
): TransactionInstruction {
  const programId = p.programId ?? DEXTER_VAULT_PROGRAM_ID;
  const [bracket] = deriveSwapBracketPda(p.vault, programId);
  const keys = [
    { pubkey: p.vault, isSigner: false, isWritable: false },
    { pubkey: bracket, isSigner: false, isWritable: true },
    { pubkey: p.vaultUsdcAta, isSigner: false, isWritable: false },
    { pubkey: p.vaultBaseAta, isSigner: false, isWritable: false },
    // Anchor optional account: None is encoded as the PROGRAM ID sentinel.
    { pubkey: p.node ?? programId, isSigner: false, isWritable: false },
    { pubkey: p.graphConfig, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
  ];
  return new TransactionInstruction({
    programId,
    keys,
    data: Buffer.from(DISCRIMINATORS.finish_swap),
  });
}

export interface WrapRouteParams {
  connection: Connection;
  swigAddress: PublicKey;
  /** The Jupiter route instruction(s) the swig wallet executes (ExactIn!). */
  routeInstructions: TransactionInstruction[];
  /** The byte-identical swap_for_carry ix (the ProgramExec preInstruction). */
  markerInstruction: TransactionInstruction;
  /** SignV2 payer. */
  payer: PublicKey;
  // ── test injection ──
  _fetchSwig?: typeof fetchSwig;
  _getSignInstructions?: typeof getSignInstructions;
}

/**
 * Wrap the route in Swig::SignV2 under the role-9 swap_for_carry marker.
 * Returns ONLY the SignV2 instruction — the caller hand-places its own
 * byte-identical swap_for_carry at [SignV2 − 1] (the program introspects both
 * adjacencies). Role is marker-matched via findProgramExecRoleId.
 */
export async function wrapRouteWithSwapSignV2(
  p: WrapRouteParams,
): Promise<TransactionInstruction> {
  const fetchSwigFn = p._fetchSwig ?? fetchSwig;
  const signFn = p._getSignInstructions ?? getSignInstructions;
  const rpc = getRpc(p.connection);
  const swig = await fetchSwigFn(rpc, kitAddress(p.swigAddress.toBase58()));
  if (!swig) {
    throw new Error(`swap SignV2: swig not found on-chain: ${p.swigAddress.toBase58()}`);
  }
  let roleId: number;
  try {
    roleId = findProgramExecRoleId(
      swig as any,
      Uint8Array.from(DEXTER_VAULT_PROGRAM_ID.toBytes()),
      SWIG_PROGRAM_EXEC_PREFIX_SWAP_FOR_CARRY,
    );
  } catch {
    // Not enrolled: the vault predates the 2026-07-18 role-9 ceremony (or is
    // one of the blocked/foreign-managed swigs). Fail closed with a NAMED code
    // so services can distinguish "needs enrollment" from transport errors.
    const err = new Error(
      `swap SignV2: swig ${p.swigAddress.toBase58()} carries no swap_for_carry ProgramExec role (role-9 not enrolled)`,
    ) as Error & { code?: string };
    err.code = 'swap_role_not_enrolled';
    throw err;
  }
  const kitIxs = await signFn(swig as any, roleId, p.routeInstructions as any, false, {
    payer: kitAddress(p.payer.toBase58()),
    preInstructions: [p.markerInstruction as any],
  } as any);
  const web3Ixs = kitInstructionsToWeb3(kitIxs);
  const signV2 = web3Ixs[1];
  if (web3Ixs.length !== 2 || !signV2) {
    throw new Error(`swap SignV2: expected [marker, SignV2], got ${web3Ixs.length} instructions`);
  }
  return signV2;
}
