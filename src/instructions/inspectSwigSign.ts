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
// instruction.rs @ rev c2e8eb4 — `SignV1 = 4`, `SignV2 = 11`.
const SWIG_SIGN_V1_DISCRIMINATOR = 4;
const SWIG_SIGN_V2_DISCRIMINATOR = 11;
// role_id is a u32 LE at byte 4 of the SignV2Args header (u16 + u16 + u32).
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
