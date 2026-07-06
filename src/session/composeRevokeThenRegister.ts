/**
 * composeRevokeThenRegister — the SHARED atomic revoke-then-register primitive
 * (K-T4 caller migration; crystallization-cadence spec §6a/§6b).
 *
 * WHY THIS EXISTS: a program guard is landing that rejects re-registering over
 * a LIVE session (`SessionAlreadyActive`). Every surface that today silently
 * overwrites a live session must instead clear it IN THE SAME TRANSACTION and
 * register fresh. This helper is that primitive — callers must not hand-roll
 * the compose (anti-bypass-drift; the SDK is the floor).
 *
 * PROGRAM SEMANTICS THE COMPOSE RELIES ON (verified against the handlers):
 *  - revoke_session_key is CLEAR-not-CLOSE: zeroes `version` + every
 *    SessionRegistration field and DECREMENTS `live_session_count`; the
 *    account stays open (rent parked).
 *  - register_session_key then reads the just-cleared PDA as version==0 ⇒
 *    is_new=true and INCREMENTS the count. Net count change across the
 *    pair = 0.
 *  - The target PDA is excluded from its own sibling set, so the register leg
 *    passes the OTHER N−1 live siblings — exactly `live_session_count` after
 *    the in-tx revoke. The sibling set the compose sends is therefore the SAME
 *    set the pre-guard replace path sent.
 *  - verify_passkey_signed introspects only the instruction at
 *    current_index − 1, so TWO secp256r1 verify siblings coexist in one tx,
 *    each immediately preceding its own vault instruction:
 *      [ …callerPre, secp(revoke), revoke_session_key,
 *                    secp(register), register_session_key ]
 *
 * TRANSPORT: caller-owned, unchanged — the composed block rides
 * registerSessionWithRetry's `preInstructions` seam (prepended verbatim on
 * every attempt; safe because the tx is atomic — a failed attempt means the
 * in-tx revoke never landed either) and the caller's `send` receives the full
 * instruction list.
 *
 * ⚠ TX SIZE (measured, load-bearing — tests/session.composeTxSize.test.ts):
 * the composed tx does NOT fit a legacy Transaction. With production-shaped
 * ceremonies + one compute-budget ix it wires at 1347 B at ZERO siblings
 * (legacy cap 1232 B; web3.js serialize() itself throws), and a v0 without a
 * lookup table is no smaller (1349 B). The `send` transport for the LIVE
 * (revoke-composed) path MUST therefore assemble a v0 VersionedTransaction
 * with an address lookup table holding the vault's static accounts (vault,
 * target session PDA, vaultUsdcAta, swig, swigWalletAddress, sysvar +
 * system program → 1166 B at 0 siblings) and, beyond 1 sibling, the sibling
 * session PDAs as well (statics-only hits the cap exactly at 2 siblings;
 * with siblings ALT-resident: 1174 B at 4). The register-only (not-live)
 * path still fits legacy comfortably (937 B).
 */
import { Connection, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha256';
import { DEXTER_VAULT_PROGRAM_ID } from '../constants/index.js';
import { buildRevokeSessionKeyInstruction } from '../instructions/revokeSession.js';
import {
  buildSecp256r1VerifyInstruction,
  buildPrecompileMessage,
} from '../precompile/secp256r1.js';
import { sessionRevokeMessage } from '../messages/session.js';
import { fetchSessionAccount, fetchVaultSessionAccounts } from './fetch.js';
import { isSessionLive } from './decode.js';
import {
  registerSessionWithRetry,
  type RegisterSessionWithRetryArgs,
} from './registerWithRetry.js';

/** A LIVE session exists for this counterparty but no `revokeCeremony` was
 *  supplied. Callers surface this as their conflict error (the API's 409
 *  `grant_already_active`): the user must approve the revocation of the live
 *  session before a new one can be registered over it. */
export class RevokeCeremonyRequiredError extends Error {
  constructor(allowedCounterparty: string) {
    super(
      `a LIVE session exists for counterparty ${allowedCounterparty}; ` +
        'composing an atomic revoke-then-register requires a revokeCeremony ' +
        'signed over sessionRevokeMessage(programId, vaultPda, liveSessionPubkey)',
    );
    this.name = 'RevokeCeremonyRequiredError';
  }
}

/** The supplied `revokeCeremony` is not bound to the CURRENT live session
 *  pubkey — the session rotated between the caller's read and this compose.
 *  Submitting it anyway would burn the tx on-chain (the handler rebuilds the
 *  revocation message from the PDA's session_pubkey and the challenge check
 *  fails), so we fail fast here. Callers map this to their rotation conflict
 *  (the API's 409 `session_rotated`): re-read the session, re-sign, retry. */
export class RevokeCeremonyMismatchError extends Error {
  constructor(allowedCounterparty: string) {
    super(
      `revokeCeremony is not bound to the CURRENT live session for counterparty ` +
        `${allowedCounterparty} (session rotated since the ceremony was signed); ` +
        're-read the session and re-sign the revoke message',
    );
    this.name = 'RevokeCeremonyMismatchError';
  }
}

/** One completed WebAuthn assertion — the three byte fields every
 *  passkey-signed vault instruction carries (== the PasskeySigner /
 *  PasskeySignerWithPublicKey sign output shape, signers/types.ts). */
export interface SignedPasskeyCeremony {
  clientDataJSON: Uint8Array;
  authenticatorData: Uint8Array;
  /** 64-byte compact (r‖s) P-256 signature over
   *  authenticatorData ‖ sha256(clientDataJSON). */
  signature: Uint8Array;
}

/** The register-leg scalars — RegisterSessionWithRetryArgs minus everything
 *  this compose owns (connection/vault/counterparty at the top level, the
 *  ceremony bytes from `registerCeremony`, transport + seams top-level). */
export type ComposeRegisterArgs = Omit<
  RegisterSessionWithRetryArgs,
  | 'connection'
  | 'vaultPda'
  | 'allowedCounterparty'
  | 'clientDataJSON'
  | 'authenticatorData'
  | 'send'
  | 'preInstructions'
  | 'maxAttempts'
  | 'fetchSessions'
  | 'fetchSession'
>;

export interface ComposeRevokeThenRegisterArgs {
  connection: Connection;
  vaultPda: PublicKey;
  allowedCounterparty: PublicKey;
  /** Register-leg args (same scalar set registerSessionWithRetry takes). */
  registerArgs: ComposeRegisterArgs;
  /** Ceremony over sessionRegisterMessage(new params). Always required. */
  registerCeremony: SignedPasskeyCeremony;
  /** Ceremony over sessionRevokeMessage(programId, vaultPda,
   *  LIVE session_pubkey). REQUIRED-IF-LIVE: omitted + live session ⇒
   *  RevokeCeremonyRequiredError; supplied + not live ⇒ ignored (no revoke
   *  instruction is composed — a revoke of a dead session would revert). */
  revokeCeremony?: SignedPasskeyCeremony;
  /** 33-byte SEC1 compressed P-256 credential public key
   *  (== vault.passkey_pubkey) — authorship for BOTH secp verify siblings. */
  credentialPublicKey: Uint8Array;
  /** Caller-owned transport (unchanged from registerSessionWithRetry):
   *  receives the FULL composed instruction list, must send + confirm
   *  ATOMICALLY in one transaction, return the signature, and THROW on
   *  failure with the program error text intact. */
  send: (instructions: TransactionInstruction[]) => Promise<string>;
  /** Prepended before the composed block on every attempt (compute budget).
   *  The secp/revoke/secp adjacencies are owned by the compose — callers only
   *  ever prepend, never interleave. */
  preInstructions?: TransactionInstruction[];
  /** Program id for the revoke-message binding (test/devnet seam).
   *  Default: the production program. */
  programId?: PublicKey;
  /** Total send attempts (registerSessionWithRetry semantics). Default 3. */
  maxAttempts?: number;
  /** Liveness clock seam (unix seconds), matching isSessionLive. */
  nowSeconds?: number;
  /** Testing/production seams (default: the real chain readers). */
  fetchSession?: typeof fetchSessionAccount;
  fetchSessions?: typeof fetchVaultSessionAccounts;
}

export interface ComposeRevokeThenRegisterResult {
  signature: string;
  /** True iff a same-tx revoke pair was composed ahead of the register
   *  (a LIVE session existed at compose time). */
  revoked: boolean;
  /** From registerSessionWithRetry's own pre-send read: a LIVE session
   *  existed for this counterparty immediately before the send. */
  replaced: boolean;
  /** Send attempts of the successful try (registerSessionWithRetry). */
  attempts: number;
  /** Sibling count of the last attempt, target excluded. */
  siblingCount: number;
}

/** clientDataJSON.challenge must base64url-decode to sha256(operationMessage)
 *  — the webauthn.rs law. Parses the ceremony's clientDataJSON and checks the
 *  binding WITHOUT trusting any other field. */
function ceremonyBindsMessage(
  ceremony: SignedPasskeyCeremony,
  operationMessage: Uint8Array,
): boolean {
  let challenge: unknown;
  try {
    challenge = (
      JSON.parse(new TextDecoder().decode(ceremony.clientDataJSON)) as {
        challenge?: unknown;
      }
    ).challenge;
  } catch {
    return false;
  }
  if (typeof challenge !== 'string') return false;
  let decoded: Buffer;
  try {
    decoded = Buffer.from(challenge, 'base64url');
  } catch {
    return false;
  }
  return decoded.equals(Buffer.from(sha256(operationMessage)));
}

/**
 * Compose (and send, via the caller's transport) an ATOMIC single-transaction
 * revoke-then-register over one (vault, counterparty) session PDA.
 *
 * Behavior:
 *  - reads the session PDA; NOT live (absent / cleared / expired) →
 *    register-only, `revoked: false` (an in-tx revoke of a dead session would
 *    revert NoActiveSession);
 *  - LIVE → requires `revokeCeremony`, verifies it binds to the CURRENT live
 *    session pubkey, and prepends [secp(revoke), revokeIx, secp(register)] so
 *    registerSessionWithRetry's appended register ix completes the 4-ix block.
 */
export async function composeRevokeThenRegister(
  args: ComposeRevokeThenRegisterArgs,
): Promise<ComposeRevokeThenRegisterResult> {
  const programId = args.programId ?? DEXTER_VAULT_PROGRAM_ID;
  const fetchSession = args.fetchSession ?? fetchSessionAccount;

  const existing = await fetchSession(
    args.connection,
    args.vaultPda,
    args.allowedCounterparty,
    programId,
  );
  const live =
    existing !== null && isSessionLive(existing, args.nowSeconds);

  const composed: TransactionInstruction[] = [];
  if (live) {
    const revokeCeremony = args.revokeCeremony;
    if (!revokeCeremony) {
      throw new RevokeCeremonyRequiredError(args.allowedCounterparty.toBase58());
    }
    // The handler rebuilds this message from the PDA's CURRENT session_pubkey;
    // a ceremony signed over a rotated-away pubkey can only revert on-chain,
    // so reject it before burning the transaction.
    const revokeMessage = sessionRevokeMessage({
      programId,
      vaultPda: args.vaultPda,
      sessionPubkey: existing.session.sessionPubkey,
    });
    if (!ceremonyBindsMessage(revokeCeremony, revokeMessage)) {
      throw new RevokeCeremonyMismatchError(args.allowedCounterparty.toBase58());
    }
    composed.push(
      buildSecp256r1VerifyInstruction(
        args.credentialPublicKey,
        revokeCeremony.signature,
        await buildPrecompileMessage(
          revokeCeremony.clientDataJSON,
          revokeCeremony.authenticatorData,
        ),
      ),
      buildRevokeSessionKeyInstruction({
        vaultPda: args.vaultPda,
        allowedCounterparty: args.allowedCounterparty,
        clientDataJSON: revokeCeremony.clientDataJSON,
        authenticatorData: revokeCeremony.authenticatorData,
      }),
    );
  }
  // The register leg's secp sibling — immediately before the register ix that
  // registerSessionWithRetry appends after the preInstructions block.
  composed.push(
    buildSecp256r1VerifyInstruction(
      args.credentialPublicKey,
      args.registerCeremony.signature,
      await buildPrecompileMessage(
        args.registerCeremony.clientDataJSON,
        args.registerCeremony.authenticatorData,
      ),
    ),
  );

  const result = await registerSessionWithRetry({
    ...args.registerArgs,
    connection: args.connection,
    vaultPda: args.vaultPda,
    allowedCounterparty: args.allowedCounterparty,
    clientDataJSON: args.registerCeremony.clientDataJSON,
    authenticatorData: args.registerCeremony.authenticatorData,
    send: args.send,
    preInstructions: [...(args.preInstructions ?? []), ...composed],
    maxAttempts: args.maxAttempts,
    fetchSessions: args.fetchSessions,
    fetchSession: args.fetchSession,
  });

  return {
    signature: result.signature,
    revoked: live,
    replaced: result.replaced,
    attempts: result.attempts,
    siblingCount: result.siblingCount,
  };
}
