/**
 * requestSpendGrant / parseSpendGrantRequest — build + harden the grant blob.
 *
 * parseSpendGrantRequest is the consent page's first touch of attacker-
 * controlled bytes: it whitelists fields (unknown keys are DROPPED, not
 * carried), bounds every string, and type-checks every number before anything
 * is rendered. Both functions funnel through the same validator so an app
 * cannot construct a blob the consent page would reject.
 */
import bs58 from 'bs58';
import type {
  RequestSpendGrantArgs,
  SpendGrantAppMetadata,
  SpendGrantCallback,
  SpendGrantRequest,
} from './types.js';

const U64_MAX = 18446744073709551615n;
const I64_MAX = 9223372036854775807n;

export class SpendGrantValidationError extends Error {
  readonly code: string;
  constructor(code: string, detail: string) {
    super(`spend-grant ${code}: ${detail}`);
    this.code = code;
    this.name = 'SpendGrantValidationError';
  }
}

function fail(code: string, detail: string): never {
  throw new SpendGrantValidationError(code, detail);
}

function requireBase58Pubkey(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) fail('bad_pubkey', `${field} must be a base58 string`);
  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(value);
  } catch {
    fail('bad_pubkey', `${field} is not valid base58`);
  }
  if (decoded.length !== 32) fail('bad_pubkey', `${field} must decode to 32 bytes, got ${decoded.length}`);
  return value;
}

function requireU64String(value: unknown, field: string, { min = 1n }: { min?: bigint } = {}): string {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    fail('bad_amount', `${field} must be a base-10 integer string`);
  }
  const n = BigInt(value);
  if (n < min) fail('bad_amount', `${field} must be >= ${min}`);
  if (n > U64_MAX) fail('bad_amount', `${field} exceeds u64`);
  return value;
}

function requireUnixSeconds(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || BigInt(value) > I64_MAX) {
    fail('bad_expiry', `${field} must be a positive integer (unix seconds)`);
  }
  const now = Math.floor(Date.now() / 1000);
  if (value <= now) fail('bad_expiry', `${field} is in the past`);
  return value;
}

function requireBoundedString(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) fail('bad_string', `${field} must be a non-empty string`);
  if (value.length > max) fail('bad_string', `${field} exceeds ${max} chars`);
  return value;
}

function requireHttpsUrl(value: unknown, field: string, max: number): string {
  const s = requireBoundedString(value, field, max);
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    fail('bad_url', `${field} is not a valid URL`);
  }
  if (u.protocol !== 'https:') fail('bad_url', `${field} must be https`);
  return s;
}

function validateApp(value: unknown): SpendGrantAppMetadata {
  if (typeof value !== 'object' || value === null) fail('bad_app', 'app must be an object');
  const v = value as Record<string, unknown>;
  const app: SpendGrantAppMetadata = {
    name: requireBoundedString(v.name, 'app.name', 64),
    domain: requireBoundedString(v.domain, 'app.domain', 128),
  };
  if (v.iconUrl !== undefined && v.iconUrl !== null) {
    app.iconUrl = requireHttpsUrl(v.iconUrl, 'app.iconUrl', 512);
  }
  return app;
}

function validateCallback(value: unknown): SpendGrantCallback {
  if (typeof value !== 'object' || value === null) fail('bad_callback', 'callback must be an object');
  const v = value as Record<string, unknown>;
  const method = v.method;
  if (method !== 'redirect' && method !== 'post') fail('bad_callback', 'callback.method must be redirect|post');
  return { url: requireHttpsUrl(v.url, 'callback.url', 1024), method };
}

/** The single validator both entry points funnel through. WHITELISTS fields. */
function validate(input: Record<string, unknown>): SpendGrantRequest {
  if (input.v !== 1) fail('bad_version', `unsupported blob version ${String(input.v)}`);
  if (input.kind !== 'dexter.spendGrantRequest') fail('bad_kind', `unexpected kind ${String(input.kind)}`);
  const proposedRaw = input.proposed;
  if (typeof proposedRaw !== 'object' || proposedRaw === null) fail('bad_proposed', 'proposed must be an object');
  const p = proposedRaw as Record<string, unknown>;

  const out: SpendGrantRequest = {
    v: 1,
    kind: 'dexter.spendGrantRequest',
    app: validateApp(input.app),
    counterparty: requireBase58Pubkey(input.counterparty, 'counterparty'),
    proposed: {
      capAtomic: requireU64String(p.capAtomic, 'proposed.capAtomic'),
      expiresAtUnix: requireUnixSeconds(p.expiresAtUnix, 'proposed.expiresAtUnix'),
    },
  };
  if (p.revolvingCapacityAtomic !== undefined && p.revolvingCapacityAtomic !== null) {
    out.proposed.revolvingCapacityAtomic = requireU64String(
      p.revolvingCapacityAtomic,
      'proposed.revolvingCapacityAtomic',
    );
  }
  if (input.sessionPubkey !== undefined && input.sessionPubkey !== null) {
    out.sessionPubkey = requireBase58Pubkey(input.sessionPubkey, 'sessionPubkey');
  }
  if (input.requestId !== undefined && input.requestId !== null) {
    out.requestId = requireBoundedString(input.requestId, 'requestId', 128);
  }
  if (input.callback !== undefined && input.callback !== null) {
    out.callback = validateCallback(input.callback);
  }
  return out;
}

/** App side: build a validated grant-request blob. */
export function requestSpendGrant(args: RequestSpendGrantArgs): SpendGrantRequest {
  const candidate: Record<string, unknown> = {
    v: 1,
    kind: 'dexter.spendGrantRequest',
    app: args.app,
    counterparty: args.counterparty,
    proposed: {
      capAtomic: args.capAtomic,
      expiresAtUnix: args.expiresAtUnix,
      ...(args.revolvingCapacityAtomic !== undefined
        ? { revolvingCapacityAtomic: args.revolvingCapacityAtomic }
        : {}),
    },
    ...(args.sessionPubkey !== undefined ? { sessionPubkey: args.sessionPubkey } : {}),
    ...(args.requestId !== undefined ? { requestId: args.requestId } : {}),
    ...(args.callback !== undefined ? { callback: args.callback } : {}),
  };
  return validate(candidate);
}

/** Consent side: harden an untrusted blob (JSON string or already-parsed object). */
export function parseSpendGrantRequest(input: unknown): SpendGrantRequest {
  let obj: unknown = input;
  if (typeof input === 'string') {
    try {
      obj = JSON.parse(input);
    } catch {
      fail('bad_json', 'input is not valid JSON');
    }
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    fail('bad_shape', 'blob must be a JSON object');
  }
  return validate(obj as Record<string, unknown>);
}

// ── URL transport (base64url JSON) ─────────────────────────────────────────

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = typeof btoa === 'function' ? btoa(bin) : Buffer.from(bytes).toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  if (typeof atob === 'function') {
    const bin = atob(b64 + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64 + pad, 'base64'));
}

/** Blob → `?req=` URL parameter value. */
export function encodeSpendGrantRequest(blob: SpendGrantRequest): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(blob)));
}

/** `?req=` URL parameter value → validated blob. */
export function decodeSpendGrantRequest(encoded: string): SpendGrantRequest {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
    fail('bad_encoding', 'encoded blob must be base64url');
  }
  return parseSpendGrantRequest(new TextDecoder().decode(base64UrlToBytes(encoded)));
}
