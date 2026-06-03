/**
 * Byte-parity + behavior tests for `@dexterai/vault/signers/browser`.
 *
 * The DER → compact lowS conversion locks against the dexter-fe
 * implementation it replaces (passkey.ts:253-313 / passkey-anon.ts:249-309).
 * If a future change to the SDK produces different bytes for the same
 * input DER, that's a P-256 protocol break and these snapshots fail.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WebAuthnAssertion,
  WebAuthnAssertionError,
  derSignatureToCompactLowS,
} from '../../src/signers/browser/index.js';

// ── Fixtures ──────────────────────────────────────────────────────────────

const KNOWN_CRED_ID = new Uint8Array(16).fill(0xab);

// Real WebAuthn-shape DER signature: SEQUENCE { INTEGER r, INTEGER s }
// Values picked so r is exactly 32 bytes (no padding) and s requires
// the lowS flip (high-S input).
function makeLowSDer(): Uint8Array {
  // r = 0x11... (32 bytes), low — no flip needed
  const r = new Uint8Array(32).fill(0x11);
  // s = 0x88... (32 bytes), this is > P256_HALF_ORDER → must be flipped
  const s = new Uint8Array(32).fill(0x88);
  return encodeDer(r, s);
}

function makeAlreadyLowSDer(): Uint8Array {
  const r = new Uint8Array(32).fill(0x11);
  const s = new Uint8Array(32).fill(0x22); // small s, no flip
  return encodeDer(r, s);
}

function makeDerWithPaddingBytes(): Uint8Array {
  // r has leading 0x00 padding (DER positive-integer convention),
  // followed by a 32-byte value whose high bit is set.
  const rRaw = new Uint8Array(32).fill(0xff);
  const r = new Uint8Array(33);
  r[0] = 0x00;
  r.set(rRaw, 1);
  const s = new Uint8Array(32).fill(0x22);
  return encodeDer(r, s);
}

function encodeDer(r: Uint8Array, s: Uint8Array): Uint8Array {
  const seqLen = 2 + r.length + 2 + s.length;
  const out = new Uint8Array(2 + seqLen);
  let i = 0;
  out[i++] = 0x30;
  out[i++] = seqLen;
  out[i++] = 0x02;
  out[i++] = r.length;
  out.set(r, i);
  i += r.length;
  out[i++] = 0x02;
  out[i++] = s.length;
  out.set(s, i);
  return out;
}

// ── derSignatureToCompactLowS — pure function ─────────────────────────────

describe('derSignatureToCompactLowS', () => {
  it('produces 64-byte r||s output (snapshot)', () => {
    const compact = derSignatureToCompactLowS(makeAlreadyLowSDer());
    expect(compact.length).toBe(64);
    expect(compact).toMatchSnapshot();
  });

  it('normalizes high-S to low-S (s ≤ n/2)', () => {
    const compact = derSignatureToCompactLowS(makeLowSDer());
    expect(compact.length).toBe(64);
    // r unchanged
    for (let i = 0; i < 32; i += 1) expect(compact[i]).toBe(0x11);
    // s should be (P256_ORDER - 0x88…88), NOT the original 0x88 bytes
    expect(compact[32]).not.toBe(0x88);
    expect(compact).toMatchSnapshot();
  });

  it('strips DER positive-integer padding byte', () => {
    const compact = derSignatureToCompactLowS(makeDerWithPaddingBytes());
    expect(compact.length).toBe(64);
    // first 32 bytes should be the 0xff payload, not the 0x00 padding
    for (let i = 0; i < 32; i += 1) expect(compact[i]).toBe(0xff);
    expect(compact).toMatchSnapshot();
  });

  it('rejects non-SEQUENCE prefix', () => {
    const bad = new Uint8Array([0x31, 0, 0]);
    expect(() => derSignatureToCompactLowS(bad)).toThrow(WebAuthnAssertionError);
  });

  it('rejects oversized r/s components', () => {
    // Forge a DER with an r component longer than 33 bytes.
    const r = new Uint8Array(34).fill(0x11);
    const s = new Uint8Array(32).fill(0x22);
    const der = encodeDer(r, s);
    expect(() => derSignatureToCompactLowS(der)).toThrow(WebAuthnAssertionError);
  });

  it('rejects missing INTEGER tag', () => {
    const bad = new Uint8Array([0x30, 0x06, 0x03, 0x01, 0xaa, 0x02, 0x01, 0xbb]);
    expect(() => derSignatureToCompactLowS(bad)).toThrow(WebAuthnAssertionError);
  });
});

// ── WebAuthnAssertion class — happy path + edge cases ────────────────────

describe('WebAuthnAssertion', () => {
  const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

  afterEach(() => {
    if (originalNavigatorDescriptor) {
      Object.defineProperty(globalThis, 'navigator', originalNavigatorDescriptor);
    } else {
      delete (globalThis as { navigator?: unknown }).navigator;
    }
    vi.restoreAllMocks();
  });

  it('rejects construction with empty credentialId', () => {
    expect(() => new WebAuthnAssertion({ credentialId: new Uint8Array(0) })).toThrow(
      WebAuthnAssertionError,
    );
  });

  it('throws not_browser when navigator.credentials is absent', async () => {
    // Override the navigator getter with one that returns an object lacking
    // .credentials. Direct delete fails on Node 22+ where navigator is a
    // built-in getter.
    Object.defineProperty(globalThis, 'navigator', {
      value: {},
      configurable: true,
      writable: true,
    });
    const signer = new WebAuthnAssertion({ credentialId: KNOWN_CRED_ID });
    await expect(signer.assertOver(new Uint8Array([1, 2, 3]))).rejects.toThrow(
      WebAuthnAssertionError,
    );
  });

  it('throws invalid_challenge for empty challenge', async () => {
    installFakeNavigator(() => {
      throw new Error('navigator.credentials.get should not be called');
    });
    const signer = new WebAuthnAssertion({ credentialId: KNOWN_CRED_ID });
    await expect(signer.assertOver(new Uint8Array(0))).rejects.toThrow(WebAuthnAssertionError);
  });

  it('throws user_cancelled when navigator returns null', async () => {
    installFakeNavigator(async () => null);
    const signer = new WebAuthnAssertion({ credentialId: KNOWN_CRED_ID });
    await expect(signer.assertOver(new Uint8Array([1, 2, 3]))).rejects.toMatchObject({
      code: 'user_cancelled',
    });
  });

  it('happy path: returns 64-byte sig + raw cdata/authdata', async () => {
    const challenge = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const fakeClientDataJSON = new TextEncoder().encode(
      '{"type":"webauthn.get","challenge":"3q2-7w","origin":"https://dexter.cash"}',
    );
    const fakeAuthData = new Uint8Array(37).fill(0x99);
    const fakeDerSig = makeAlreadyLowSDer();

    const credentialsGet = vi.fn(async (opts: CredentialRequestOptions) => {
      // Confirm the SDK forwards our challenge unchanged.
      const pk = (opts as { publicKey: PublicKeyCredentialRequestOptions }).publicKey;
      const sent = new Uint8Array(pk.challenge as ArrayBuffer);
      expect([...sent]).toEqual([...challenge]);
      // Confirm allowCredentials defaulted to our cred ID.
      expect(pk.allowCredentials?.[0].type).toBe('public-key');
      return {
        type: 'public-key',
        response: {
          signature: fakeDerSig.buffer,
          clientDataJSON: fakeClientDataJSON.buffer,
          authenticatorData: fakeAuthData.buffer,
        },
      } as unknown as Credential;
    });
    installFakeNavigator(credentialsGet);

    const signer = new WebAuthnAssertion({
      credentialId: KNOWN_CRED_ID,
      rpId: 'dexter.cash',
    });
    const result = await signer.assertOver(challenge);

    expect(credentialsGet).toHaveBeenCalledOnce();
    expect(result.signature.length).toBe(64);
    expect(result.clientDataJSON).toEqual(fakeClientDataJSON);
    expect(result.authenticatorData).toEqual(fakeAuthData);
  });

  it('sign() is an alias for assertOver()', async () => {
    installFakeNavigator(async () => ({
      type: 'public-key',
      response: {
        signature: makeAlreadyLowSDer().buffer,
        clientDataJSON: new Uint8Array([1]).buffer,
        authenticatorData: new Uint8Array([2]).buffer,
      },
    } as unknown as Credential));
    const signer = new WebAuthnAssertion({ credentialId: KNOWN_CRED_ID });
    const a = await signer.sign(new Uint8Array([9]));
    expect(a.signature.length).toBe(64);
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────

function installFakeNavigator(
  getImpl: (opts: CredentialRequestOptions) => Promise<Credential | null>,
): void {
  Object.defineProperty(globalThis, 'navigator', {
    value: { credentials: { get: getImpl } },
    configurable: true,
    writable: true,
  });
}
