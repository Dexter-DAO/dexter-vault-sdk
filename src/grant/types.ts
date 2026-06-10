/**
 * Connect-a-Tab leg 2 — the spend-grant request blob ("open a tab with <App>").
 *
 * The blob is UNTRUSTED DISPLAY INPUT: it carries the app's identity claims and
 * the PROPOSED scope. Trust pins on the counterparty ADDRESS (the on-chain
 * binding — it is the session PDA seed) plus the sponsor's invite-list lookup.
 * The blob itself is never signed in v1 (app-attested blobs are a deferred
 * hardening). The signed 188-byte registration message is the only truth.
 *
 * Deliberate exclusions (see the Phase-1 research doc §2.2):
 *  - NO vaultPda: the vault is the USER's, resolved by the consent page from
 *    their own identity. An app-supplied vaultPda is a phishing surface.
 *  - NO nonce: consent-page chosen at ceremony time.
 */

/** Display metadata — consent-screen only, never signed on-chain. */
export interface SpendGrantAppMetadata {
  /** Required; shown as the headline identity. Max 64 chars. */
  name: string;
  /** Required; shown beside the counterparty address. Max 128 chars. */
  domain: string;
  /** Optional; https only. Max 512 chars. */
  iconUrl?: string;
}

export interface SpendGrantProposed {
  /** u64 string, USDC 6dp — user may only SHORTEN. */
  capAtomic: string;
  /** unix seconds — user may only SHORTEN. */
  expiresAtUnix: number;
  /** Optional; absent ⇒ defaults to cap; shown only when ≠ cap; clamped ≤ final cap. */
  revolvingCapacityAtomic?: string;
}

export interface SpendGrantCallback {
  /** https URL the consent page reports the outcome to. */
  url: string;
  method: 'redirect' | 'post';
}

export interface SpendGrantRequest {
  v: 1;
  kind: 'dexter.spendGrantRequest';
  app: SpendGrantAppMetadata;
  /** REQUIRED — the seller settlement address (base58). THE on-chain binding. */
  counterparty: string;
  proposed: SpendGrantProposed;
  /**
   * Optional requester-supplied buyer-agent session pubkey (base58, ed25519).
   * Present ⇒ custody mode (ii): the requester's agent holds the secret and
   * can spend to cap on its own pacing. Absent ⇒ approveSpendGrant generates
   * the keypair browser-side (custody mode (i)). Either way exposure is
   * bounded by the consented cap/expiry/counterparty.
   */
  sessionPubkey?: string;
  /** App-side correlation only; NOT the on-chain nonce. Max 128 chars. */
  requestId?: string;
  callback?: SpendGrantCallback;
}

/** Inputs to requestSpendGrant (app side). */
export interface RequestSpendGrantArgs {
  app: SpendGrantAppMetadata;
  counterparty: string;
  capAtomic: string;
  expiresAtUnix: number;
  revolvingCapacityAtomic?: string;
  sessionPubkey?: string;
  requestId?: string;
  callback?: SpendGrantCallback;
}
