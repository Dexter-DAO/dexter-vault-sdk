/**
 * Swig Sign-instruction inspector — reads the `role_id` each swig Sign in a
 * transaction authorizes, so a master-signer / off-switch gate can enforce a
 * default-deny role policy.
 *
 * Why this exists: the anon-pay heal arms a role-2 Ed25519 session whose spend
 * is an open-ended `SignV2(role 2)` → arbitrary-payee transfer. The agent-spend
 * off-switch only works if EVERY path that can master-sign a role-2 spend is
 * gated. The generic master co-signer (`/internal/sign-transaction`'s
 * `alsoSignWithSessionMaster`) is one such path, so it must refuse to co-sign a
 * tx carrying the open-ended role-2 authority while still allowing the scoped
 * flows it was built for (role-3 tab settle, and vault-program ixs like
 * initialize_vault that contain no swig Sign at all).
 *
 * Format (verified against swig program source @ rev c2e8eb4):
 *   - swig program id: SWIG_PROGRAM_ID
 *   - SwigInstruction discriminator: u16 LE at byte 0 (SignV1 = 4, SignV2 = 11)
 *   - SignV2Args header = { u16 instruction, u16 instruction_payload_len,
 *     u32 role_id } → role_id is a u32 LE at byte offset 4. SignV1 shares the
 *     same header layout, so the role_id offset is identical.
 *
 * Reads the compiled v0 message directly. No RPC and no address-lookup-table
 * resolution are needed: an invoked program's id is always a static account key,
 * never a LUT entry, so `programIdIndex` resolves against `staticAccountKeys`.
 */

import type { VersionedTransaction } from '@solana/web3.js';
import { SWIG_PROGRAM_ID } from '../constants/index.js';

// SwigInstruction discriminators (u16 LE @ byte 0). Source: swig program
// instruction.rs @ rev c2e8eb4. Full enum: CreateV1=0, AddAuthorityV1=1,
// RemoveAuthorityV1=2, UpdateAuthorityV1=3, SignV1=4, CreateSessionV1=5,
// CreateSubAccountV1=6, WithdrawFromSubAccountV1=7, SubAccountSignV1=9,
// ToggleSubAccountV1=10, SignV2=11, MigrateToWalletAddressV1=12,
// TransferAssetsV1=13.
const SWIG_CREATE_V1_DISCRIMINATOR = 0;
const SWIG_SIGN_V1_DISCRIMINATOR = 4;
const SWIG_SIGN_V2_DISCRIMINATOR = 11;
// role_id is a u32 LE at byte 4 of the SignV2Args header (u16 + u16 + u32).
// SignV1 shares the header layout, so the offset is identical.
const SWIG_ROLE_ID_OFFSET = 4;
const SWIG_SIGN_HEADER_LEN = 8;

export interface SwigSignInspection {
  /** role_id of every swig SignV2 instruction in the tx, in instruction order. */
  signV2RoleIds: number[];
  /** role_id of every legacy swig SignV1 instruction in the tx, in order. */
  signV1RoleIds: number[];
}

/**
 * Inspect a (deserialized) transaction and return the role_id each swig Sign
 * instruction authorizes, split by Sign variant. Non-swig instructions are
 * ignored. Use the result to gate which roles a key may co-sign for.
 */
export function inspectSwigSignInstructions(tx: VersionedTransaction): SwigSignInspection {
  const signV2RoleIds: number[] = [];
  const signV1RoleIds: number[] = [];
  const keys = tx.message.staticAccountKeys;

  for (const ix of tx.message.compiledInstructions) {
    const programId = keys[ix.programIdIndex];
    if (!programId || !programId.equals(SWIG_PROGRAM_ID)) continue;

    const data = ix.data;
    if (data.length < SWIG_SIGN_HEADER_LEN) continue;

    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const disc = view.getUint16(0, true);
    if (disc !== SWIG_SIGN_V1_DISCRIMINATOR && disc !== SWIG_SIGN_V2_DISCRIMINATOR) continue;

    const roleId = view.getUint32(SWIG_ROLE_ID_OFFSET, true);
    if (disc === SWIG_SIGN_V2_DISCRIMINATOR) signV2RoleIds.push(roleId);
    else signV1RoleIds.push(roleId);
  }

  return { signV2RoleIds, signV1RoleIds };
}

/**
 * Default-deny policy check for a master-signer gate. Returns true iff the tx is
 * safe to co-sign with a privileged (e.g. systemic session-master) key:
 *   - NO legacy SignV1 is present (no dexter flow master-signs SignV1), and
 *   - every SignV2 role_id is in `allowedRoles`.
 *
 * Pass the roles legitimately master-signed (e.g. `[SETTLE_TAB_ROLE_ID]` = `[3]`).
 * The open-ended role-2 spend must flow through the gated build-payment path,
 * never a generic co-signer — so role 2 is absent from `allowedRoles` and any
 * tx carrying it is refused here.
 */
export function isMasterSignSafe(
  tx: VersionedTransaction,
  allowedRoles: readonly number[],
): boolean {
  const { signV1RoleIds, signV2RoleIds } = inspectSwigSignInstructions(tx);
  if (signV1RoleIds.length > 0) return false;
  return signV2RoleIds.every((roleId) => allowedRoles.includes(roleId));
}

export interface SwigInstructionRef {
  /** The SwigInstruction discriminator (u16 LE @0). -1 if the data is too short to read. */
  discriminator: number;
  /** role_id (u32 LE @4), present only for Sign variants (SignV1 / SignV2). */
  roleId?: number;
}

/**
 * Classify EVERY swig instruction in a transaction by discriminator (and role_id
 * for Sign variants). Non-swig instructions are omitted. The general primitive
 * behind `isSwigCoSignSafe` / `isMasterSignSafe`; use it when you need the raw
 * instruction-type list (e.g. to allowlist co-signing on an arbitrary key path).
 */
export function inspectSwigInstructions(tx: VersionedTransaction): SwigInstructionRef[] {
  const out: SwigInstructionRef[] = [];
  const keys = tx.message.staticAccountKeys;

  for (const ix of tx.message.compiledInstructions) {
    const programId = keys[ix.programIdIndex];
    if (!programId || !programId.equals(SWIG_PROGRAM_ID)) continue;

    const data = ix.data;
    if (data.length < 2) {
      out.push({ discriminator: -1 }); // malformed swig ix → caller refuses
      continue;
    }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const discriminator = view.getUint16(0, true);
    const ref: SwigInstructionRef = { discriminator };
    if (
      (discriminator === SWIG_SIGN_V1_DISCRIMINATOR || discriminator === SWIG_SIGN_V2_DISCRIMINATOR) &&
      data.length >= SWIG_SIGN_HEADER_LEN
    ) {
      ref.roleId = view.getUint32(SWIG_ROLE_ID_OFFSET, true);
    }
    out.push(ref);
  }
  return out;
}

export interface SwigCoSignPolicy {
  /** SignV2 role_ids that may be co-signed (e.g. [SETTLE_TAB_ROLE_ID] = [3]). */
  allowedSignV2Roles: readonly number[];
  /** Permit a swig CreateV1 (vault creation). Worst-case abuse is fee-payer SOL grief, not theft. */
  allowCreate?: boolean;
}

/**
 * Comprehensive default-deny gate for co-signing a tx with a privileged key on a
 * path that signs UNCONDITIONALLY — e.g. the fee-payer (role-0 ManageAuthority)
 * co-sign in `/internal/sign-transaction`, which applies regardless of the
 * master-sign flag. Returns true iff every swig instruction in the tx is either:
 *   - a SignV2 whose role_id is in `allowedSignV2Roles`, or
 *   - a CreateV1 (only when `allowCreate`).
 * EVERYTHING else is refused: AddAuthorityV1 / RemoveAuthorityV1 / UpdateAuthorityV1
 * (the uncapped-role-grant escalation — role-0 could mint a new unlimited spend
 * role, sidestepping every cap), CreateSessionV1, SignV1, SignV2 role∉allowed, the
 * sub-account family, TransferAssetsV1, and any unknown/malformed swig ix.
 * Non-swig instructions are ignored.
 *
 * This SUPERSEDES `isMasterSignSafe` for the co-sign gate: a role-2 spend (SignV2
 * role 2) is refused here too. Apply it on EVERY call to the co-signing endpoint,
 * before the privileged signature is added.
 */
export function isSwigCoSignSafe(tx: VersionedTransaction, policy: SwigCoSignPolicy): boolean {
  const allowCreate = policy.allowCreate ?? false;
  for (const ix of inspectSwigInstructions(tx)) {
    if (ix.discriminator === SWIG_SIGN_V2_DISCRIMINATOR) {
      if (ix.roleId === undefined || !policy.allowedSignV2Roles.includes(ix.roleId)) return false;
    } else if (ix.discriminator === SWIG_CREATE_V1_DISCRIMINATOR) {
      if (!allowCreate) return false;
    } else {
      return false; // any other swig instruction is not co-signable
    }
  }
  return true;
}
