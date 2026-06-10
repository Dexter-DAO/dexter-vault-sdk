/**
 * approveSpendGrant — the consent-side half of the grant ceremony.
 *
 * ENDS AT THE SIGNED GRANT (deliberate): applies the user's shorten-only
 * edits, resolves session-key custody, builds the byte-exact 188-byte
 * registration message, runs the INJECTED sign function over it (the
 * browser passes its WebAuthn pipeline; tests pass a recorder), and returns
 * { message, params, ceremony, sessionKeypair? }.
 *
 * It does NOT build the register instruction. The V6 sibling contract
 * requires the sibling set be fetched FRESH immediately before building +
 * sending (src/session/fetch.ts) — an instruction built in the browser is
 * stale by the time it reaches the sponsor, and the sponsor is the payer
 * signer anyway. Self-hosted integrators who pay their own rent use
 * buildRegisterSessionKeyInstruction / registerSessionWithRetry directly.
 */
import { PublicKey } from '@solana/web3.js';
import nacl from 'tweetnacl';
// bs58 default-import is BROKEN in the tsup CJS artifact (the 0.7.0 trap);
// the shared shim peels the wrapper layers. See src/grant/bs58.ts.
import { bs58 } from './bs58.js';
import { DEXTER_VAULT_PROGRAM_ID } from '../constants/index.js';
import { sessionRegisterMessage } from '../messages/session.js';
import type { SpendGrantRequest } from './types.js';

const U64_MAX = 18446744073709551615n;

/** Dependency-free constant-shape byte compare (browser-safe; no Buffer). */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export class GrantEditError extends Error {
  readonly code: string;
  constructor(code: string, detail: string) {
    super(`grant edit rejected (${code}): ${detail}`);
    this.code = code;
    this.name = 'GrantEditError';
  }
}

/** User edits from the consent screen. SHORTEN-ONLY — raises throw. */
export interface ApproveSpendGrantEdits {
  capAtomic?: string;
  expiresAtUnix?: number;
}

export interface ApproveSpendGrantArgs<TSig> {
  /** Parsed + validated blob (parseSpendGrantRequest output). */
  request: SpendGrantRequest;
  /** The USER's vault — resolved from their own identity, never the blob. */
  vaultPda: PublicKey;
  /** The ceremony seam: receives the exact 188 bytes the passkey must endorse. */
  sign: (message: Uint8Array) => Promise<TSig>;
  edits?: ApproveSpendGrantEdits;
  /** u32. Default: unix seconds (program doesn't enforce monotonicity). */
  nonce?: number;
  /**
   * Custody mode (i) override: caller-supplied keypair (e.g. pre-generated for
   * delivery to a specific runtime). Mutually exclusive with a blob that
   * carries sessionPubkey. Absent + no blob key ⇒ generated here via nacl.
   */
  sessionKeypair?: { publicKey: Uint8Array; privateKey: Uint8Array };
  programId?: PublicKey;
}

/** The final consented values — exactly what the sponsor endpoint consumes. */
export interface ApprovedSpendGrantParams {
  counterparty: string;            // base58
  sessionPubkey: string;           // base58
  maxAmountAtomic: string;         // u64 string
  expiresAtUnix: number;
  nonce: number;
  maxRevolvingCapacityAtomic: string;
}

export interface ApprovedSpendGrant<TSig> {
  /** The 188-byte registration message the ceremony signed. */
  message: Uint8Array;
  params: ApprovedSpendGrantParams;
  /** Whatever the injected sign function returned (browser: the WebAuthn payload). */
  ceremony: TSig;
  /** Generated keypair (custody mode i) or null when the blob supplied the pubkey. */
  sessionKeypair: { publicKey: Uint8Array; privateKey: Uint8Array } | null;
  /** Which fields the user actually shortened (for the receipt + callback). */
  shortened: { cap: boolean; expiry: boolean };
}

export async function approveSpendGrant<TSig>(
  args: ApproveSpendGrantArgs<TSig>,
): Promise<ApprovedSpendGrant<TSig>> {
  const { request, edits } = args;
  const programId = args.programId ?? DEXTER_VAULT_PROGRAM_ID;
  const now = Math.floor(Date.now() / 1000);

  // ── shorten-only cap ────────────────────────────────────────────────────
  const proposedCap = BigInt(request.proposed.capAtomic);
  let finalCap = proposedCap;
  if (edits?.capAtomic !== undefined) {
    if (!/^\d+$/.test(edits.capAtomic)) throw new GrantEditError('bad_cap', 'cap must be an integer string');
    // u64::MAX is 20 digits; bound before BigInt to keep conversion cheap.
    if (edits.capAtomic.length > 20) throw new GrantEditError('bad_cap', 'cap exceeds u64');
    finalCap = BigInt(edits.capAtomic);
    if (finalCap > U64_MAX) throw new GrantEditError('bad_cap', 'cap exceeds u64');
    if (finalCap <= 0n) throw new GrantEditError('cap_zero', 'cap must be > 0');
    if (finalCap > proposedCap) {
      throw new GrantEditError('cap_raise', `cap ${finalCap} exceeds proposed ${proposedCap} — shorten only`);
    }
  }

  // ── shorten-only expiry ─────────────────────────────────────────────────
  const proposedExpiry = request.proposed.expiresAtUnix;
  let finalExpiry = proposedExpiry;
  if (edits?.expiresAtUnix !== undefined) {
    if (!Number.isInteger(edits.expiresAtUnix)) throw new GrantEditError('bad_expiry', 'expiry must be an integer');
    finalExpiry = edits.expiresAtUnix;
    if (finalExpiry > proposedExpiry) {
      throw new GrantEditError('expiry_raise', `expiry ${finalExpiry} exceeds proposed ${proposedExpiry} — shorten only`);
    }
  }
  if (finalExpiry <= now) throw new GrantEditError('expiry_past', 'expiry must be in the future');

  // ── revolving: default = cap, clamp ≤ final cap, must stay > 0 ──────────
  const requestedRevolving =
    request.proposed.revolvingCapacityAtomic !== undefined
      ? BigInt(request.proposed.revolvingCapacityAtomic)
      : finalCap;
  const finalRevolving = requestedRevolving < finalCap ? requestedRevolving : finalCap;
  if (finalRevolving <= 0n) throw new GrantEditError('revolving_zero', 'revolving capacity must be > 0');

  // ── session-key custody ─────────────────────────────────────────────────
  let sessionPubkeyBytes: Uint8Array;
  let sessionKeypair: { publicKey: Uint8Array; privateKey: Uint8Array } | null;
  if (request.sessionPubkey !== undefined) {
    if (args.sessionKeypair !== undefined) {
      throw new GrantEditError(
        'custody_conflict',
        'blob carries sessionPubkey AND a sessionKeypair was passed — exactly one source allowed',
      );
    }
    sessionPubkeyBytes = bs58.decode(request.sessionPubkey);
    sessionKeypair = null; // the requester's agent holds the secret
  } else if (args.sessionKeypair !== undefined) {
    // The privateKey must actually correspond to the publicKey — otherwise the
    // user endorses a session key the agent can never sign with (or worse,
    // a different one than it thinks it holds). Derive from the SEED
    // (fromSecretKey merely copies bytes 32..64, so a spliced secret
    // seedA||pubB would pass a fromSecretKey comparison while producing
    // signatures that never verify).
    if (args.sessionKeypair.privateKey.length !== 64) {
      throw new GrantEditError('bad_session_key', 'sessionKeypair.privateKey must be a 64-byte ed25519 secret key');
    }
    let derived: { publicKey: Uint8Array };
    try {
      derived = nacl.sign.keyPair.fromSeed(args.sessionKeypair.privateKey.slice(0, 32));
    } catch {
      throw new GrantEditError('bad_session_key', 'sessionKeypair.privateKey is not a valid ed25519 secret key');
    }
    if (
      !bytesEqual(derived.publicKey, args.sessionKeypair.publicKey) ||
      !bytesEqual(derived.publicKey, args.sessionKeypair.privateKey.slice(32))
    ) {
      throw new GrantEditError('bad_session_key', 'sessionKeypair publicKey does not match privateKey');
    }
    sessionPubkeyBytes = args.sessionKeypair.publicKey;
    sessionKeypair = args.sessionKeypair;
  } else {
    const kp = nacl.sign.keyPair();
    sessionPubkeyBytes = kp.publicKey;
    sessionKeypair = { publicKey: kp.publicKey, privateKey: kp.secretKey };
  }
  if (sessionPubkeyBytes.length !== 32) {
    throw new GrantEditError('bad_session_key', `session pubkey must be 32 bytes, got ${sessionPubkeyBytes.length}`);
  }

  const nonce = args.nonce ?? now;
  // sessionRegisterMessage writes the nonce as a raw u32 (`>>> 0` truncates);
  // gate here so params can never diverge from the bytes the user signs.
  if (!Number.isInteger(nonce) || nonce < 0 || nonce > 0xffffffff) {
    throw new GrantEditError('bad_nonce', 'nonce must be a u32');
  }
  const counterparty = new PublicKey(request.counterparty);

  const message = sessionRegisterMessage({
    programId,
    vaultPda: args.vaultPda,
    sessionPubkey: sessionPubkeyBytes,
    maxAmount: finalCap,
    expiresAt: BigInt(finalExpiry),
    allowedCounterparty: counterparty,
    nonce,
    maxRevolvingCapacity: finalRevolving,
  });

  const ceremony = await args.sign(message);

  return {
    message,
    params: {
      counterparty: counterparty.toBase58(),
      sessionPubkey: bs58.encode(sessionPubkeyBytes),
      maxAmountAtomic: finalCap.toString(),
      expiresAtUnix: finalExpiry,
      nonce,
      maxRevolvingCapacityAtomic: finalRevolving.toString(),
    },
    ceremony,
    sessionKeypair,
    shortened: { cap: finalCap !== proposedCap, expiry: finalExpiry !== proposedExpiry },
  };
}
