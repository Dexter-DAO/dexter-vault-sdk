/**
 * readSwigSessionRole — liveness read for a Swig account's session-based role.
 *
 * This is the "is the session armed?" primitive for the agent-pay heal. It is
 * the SWIG-layer session (e.g. role-2 Ed25519Session, master 3SWJ), NOT the
 * dexter-vault program's per-counterparty SessionAccount PDA — that is a
 * different object decoded by ./decode.ts. Do not confuse the two.
 *
 * THE BUG CLASS THIS GUARDS (2026-05-31, reconfirmed 2026-06-22):
 *   set_swig_atomic registers a session role with a NULL (all-zeros) session key
 *   and currentSessionExpiration = 0. The key is only filled in by
 *   getCreateSessionInstructions. If nothing ever activates it, the role is
 *   "dormant" — a settle that tries to sign with the master key fails deep inside
 *   web3.js with "Cannot sign with non signer key" and no useful context.
 *
 * THE TWO CONSUMERS:
 *   (a) facilitator settle branch — `armed === true` → settle-only (the proven
 *       1051–1232 B tx); `armed === false` → 2-tx cold heal (arm → settle).
 *   (b) auto-re-arm — `slotsRemaining` drives the proactive re-arm threshold so
 *       the session is refreshed BEFORE it lapses and the hot path stays
 *       settle-only.
 *
 * SLOTS, NOT SECONDS: the swig session expiry (`currentSessionExpiration`) is a
 * SLOT number, not a unix timestamp. Liveness is decided against the current
 * SLOT (`rpc.getSlot`), never against `Date.now()`. Keeping that decode here, in
 * one place, is the whole point — no consumer hand-rolls the slot math.
 */

import { Connection, PublicKey, type Commitment } from '@solana/web3.js';
import { fetchSwig } from '@swig-wallet/kit';
import { address as kitAddress } from '@solana/kit';
import bs58 from 'bs58';

import { getRpc } from '../kit/index.js';

/** Liveness of a swig session role. */
export type SwigSessionLiveness = 'armed' | 'dormant' | 'expired';

export interface SwigSessionRoleState {
  /** sessionKey is set AND expiresAtSlot > currentSlot. The only flag the settle
   *  branch needs: true → settle-only; false → 2-tx cold heal. */
  armed: boolean;
  /** 'dormant' = never activated (null session key); 'expired' = had a key, slot
   *  has passed; 'armed' = key set and unexpired. */
  state: SwigSessionLiveness;
  /** Base58 session key when set (the master pubkey when armed), else null. An
   *  expired role keeps its key — this reports what the lapsed session WAS. */
  sessionKey: string | null;
  /** The on-chain session expiry, in SLOTS. 0n for a never-activated role. */
  expiresAtSlot: bigint;
  /** The slot the read was taken against. */
  currentSlot: bigint;
  /** expiresAtSlot − currentSlot. <= 0 means re-arm now (dormant/expired both
   *  surface here as a non-positive value); positive is the runway before lapse. */
  slotsRemaining: bigint;
}

/**
 * Pure liveness derivation — no RPC, no swig object. Split out so the slot math
 * is exhaustively unit-testable and the async wrapper stays a thin fetch.
 *
 * `sessionKeyBytes` empty or all-zeros ⟹ dormant (treated identically; both mean
 * "no live session key"). dormant short-circuits before the expiry check because
 * a never-activated role's expiresAtSlot is a meaningless 0.
 */
export function deriveSwigSessionRoleState(input: {
  sessionKeyBytes: Uint8Array;
  expiresAtSlot: bigint;
  currentSlot: bigint;
}): SwigSessionRoleState {
  const { sessionKeyBytes, expiresAtSlot, currentSlot } = input;
  const dormant = sessionKeyBytes.length === 0 || sessionKeyBytes.every((b) => b === 0);
  const slotsRemaining = expiresAtSlot - currentSlot;

  let state: SwigSessionLiveness;
  if (dormant) state = 'dormant';
  else if (expiresAtSlot <= currentSlot) state = 'expired';
  else state = 'armed';

  return {
    armed: state === 'armed',
    state,
    sessionKey: dormant ? null : bs58.encode(sessionKeyBytes),
    expiresAtSlot,
    currentSlot,
    slotsRemaining,
  };
}

export interface ReadSwigSessionRoleOptions {
  /** Commitment for the swig fetch + getSlot. Default 'confirmed'. */
  commitment?: Commitment;
  // ── test / advanced injection ──
  /** Inject a fake fetchSwig (unit tests). */
  _fetchSwig?: typeof fetchSwig;
  /** Pin the current slot (unit tests / deterministic reads) instead of querying. */
  _currentSlot?: bigint;
}

/**
 * Read the liveness of `roleId` on the swig at `swigAddress`.
 *
 * Throws if the swig is absent, the role does not exist, or the role is not
 * session-based — those are misconfigurations, not runtime states, and the heal
 * should only call this on a known session role (e.g. role-2). A loud throw
 * keeps the bug class from regressing silently.
 */
export async function readSwigSessionRole(
  connection: Connection,
  swigAddress: PublicKey,
  roleId: number,
  options: ReadSwigSessionRoleOptions = {},
): Promise<SwigSessionRoleState> {
  const fetchSwigFn = options._fetchSwig ?? fetchSwig;
  const commitment = options.commitment ?? 'confirmed';
  const rpc = getRpc(connection);

  const swig = await fetchSwigFn(rpc, kitAddress(swigAddress.toBase58()));
  if (!swig) {
    throw new Error(`readSwigSessionRole: swig not found on-chain: ${swigAddress.toBase58()}`);
  }

  const role = (swig as any).findRoleById?.(roleId) ?? null;
  if (!role) {
    throw new Error(
      `readSwigSessionRole: role ${roleId} not found on swig ${swigAddress.toBase58()}`,
    );
  }
  if (!role.isSessionBased?.()) {
    throw new Error(
      `readSwigSessionRole: role ${roleId} on swig ${swigAddress.toBase58()} is not session-based`,
    );
  }

  // Ed25519SessionAuthority.signer = sessionKey bytes (all-zeros when dormant);
  // .expirySlot = currentSessionExpiration (u64 slot, bigint; 0n when dormant).
  const authority = (role as any).authority;
  const rawSigner = authority?.signer;
  const sessionKeyBytes: Uint8Array =
    rawSigner instanceof Uint8Array ? rawSigner : Uint8Array.from(rawSigner ?? []);
  const expiresAtSlot = BigInt(authority?.expirySlot ?? 0);

  const currentSlot =
    options._currentSlot ?? BigInt(await rpc.getSlot({ commitment }).send());

  return deriveSwigSessionRoleState({ sessionKeyBytes, expiresAtSlot, currentSlot });
}
