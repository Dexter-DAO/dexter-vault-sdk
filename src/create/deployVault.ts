import { buildSetSwigOperationMessage } from '../messages/operations.js';
import type { PasskeySignerWithPublicKey } from '../signers/types.js';

export interface DeployVaultOptions {
  /** base64url-encoded 16-byte user handle. */
  userHandle: string;
  /** Swig state address (base58 string) returned by /initialize. */
  swigStateAddress: string;
  /** Passkey signer — signs the set_swig operation message via signOperation(). */
  signer: PasskeySignerWithPublicKey;
  /** Base URL for the Dexter API. Defaults to "https://api.dexter.cash". */
  baseUrl?: string;
  /** Injectable fetch for tests. Defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
}

export interface DeployVaultResult {
  swigAddress: string;
  signature: string | null;
  alreadyActive: boolean;
}

/**
 * Thrown when the vault's USDC ATA does not hold enough funds to cover
 * the on-chain deploy (CreateV1 + set_swig rent, paid by the facilitator
 * on the user's behalf once the floor is met).
 *
 * The floor is $1.00 USDC (1_000_000 atomic). The error carries the
 * server's authoritative `floorAtomic` and `balanceAtomic` strings so
 * callers can display an accurate "deposit X more USDC" message.
 */
export class InsufficientFundsForDeployError extends Error {
  readonly code = 'insufficient_funds_for_deploy';
  /** Minimum atomic USDC required (string to preserve precision). */
  readonly floorAtomic: string;
  /** Current balance of the Swig wallet USDC ATA in atomic units. */
  readonly balanceAtomic: string;

  constructor(floorAtomic: string, balanceAtomic: string) {
    super(
      `insufficient funds for deploy: balance ${balanceAtomic} atomic USDC < floor ${floorAtomic} atomic USDC`,
    );
    this.name = 'InsufficientFundsForDeployError';
    this.floorAtomic = floorAtomic;
    this.balanceAtomic = balanceAtomic;
  }
}

/**
 * Deploy a counterfactual vault by:
 *   1. Building the set_swig operation message (bytes("set_swig") || swigStatePda).
 *   2. Having the signer produce a WebAuthn assertion over sha256(operationMessage).
 *      NOTE: the on-chain secp256r1 precompile verifies over sha256(operationMessage),
 *      which is what the WebAuthn challenge in clientDataJSON encodes. The signer's
 *      sign() call accepts the RAW operation message; the ceremony (buildClientDataJSON
 *      + sha256) happens inside the WebAuthn authenticator. This mirrors exactly what
 *      buildSetSwigPasskeyPayload does in prove-turnkey-deploy.mjs:338-341.
 *   3. POSTing { userHandle, setSwig: { clientDataJSON, authenticatorData, signature } }
 *      to /api/passkey-vault-anon/warmup. All byte fields are base64-encoded strings.
 *
 * On HTTP 409 with code "insufficient_funds_for_deploy", throws
 * InsufficientFundsForDeployError (not a generic Error) so callers can
 * distinguish the funds-gate from other failures.
 *
 * Idempotent: if the Swig is already deployed the server returns
 * { alreadyActive: true } with HTTP 200.
 */
export async function deployVault(opts: DeployVaultOptions): Promise<DeployVaultResult> {
  const baseUrl = opts.baseUrl ?? 'https://api.dexter.cash';
  const fetchFn = opts.fetch ?? globalThis.fetch;

  // Build the set_swig operation message: bytes("set_swig") || swigStatePda (32 bytes).
  // This is the message the on-chain handler verifies (see operations.ts:15-22 and
  // firstUseBundle.ts which reads the challenge from sha256(operationMessage) embedded
  // in the clientDataJSON produced by the WebAuthn ceremony).
  const operationMessage = buildSetSwigOperationMessage(opts.swigStateAddress);

  // Pass the RAW operation message to the signer. The SIGNER hashes it
  // (sha256) and binds that hash as the WebAuthn challenge in clientDataJSON
  // (clientDataJSON.challenge === sha256(operationMessage)), then signs
  // authenticatorData || sha256(clientDataJSON) — exactly what the on-chain
  // webauthn.rs law requires and what buildClientDataJSON +
  // signOperationWithPasskey does in the prove-turnkey-deploy.mjs proof
  // script (lines 255-263 + 338-341).
  const { signature, clientDataJSON, authenticatorData } = await opts.signer.signOperation(operationMessage);

  // All byte fields sent to the warmup endpoint are plain base64 strings.
  // Confirmed from passkeyVaultAnon.ts:863-864: base64ToBytes() is used to
  // decode them on the server side (not base64url).
  const toBase64 = (b: Uint8Array) => Buffer.from(b).toString('base64');

  const body = {
    userHandle: opts.userHandle,
    setSwig: {
      clientDataJSON: toBase64(clientDataJSON),
      authenticatorData: toBase64(authenticatorData),
      signature: toBase64(signature),
    },
  };

  const res = await fetchFn(`${baseUrl}/api/passkey-vault-anon/warmup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  const json = await res.json() as {
    swigAddress?: string;
    signature?: string;
    alreadyActive?: boolean;
    error?: string;
    floorAtomic?: string;
    balanceAtomic?: string;
  };

  // Funds gate: HTTP 409 with code insufficient_funds_for_deploy.
  if (res.status === 409 && json.error === 'insufficient_funds_for_deploy') {
    throw new InsufficientFundsForDeployError(
      json.floorAtomic ?? '1000000',
      json.balanceAtomic ?? '0',
    );
  }

  if (!res.ok) {
    throw new Error(
      `deployVault: /warmup returned HTTP ${res.status}: ${json.error ?? 'unknown'}`,
    );
  }

  return {
    swigAddress: json.swigAddress ?? '',
    signature: json.signature ?? null,
    alreadyActive: json.alreadyActive ?? false,
  };
}
