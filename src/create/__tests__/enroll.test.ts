// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { enrollPasskey } from '../enroll.js';

// Minimal fake of a WebAuthn create() credential. The attestationObject parsing
// is exercised via a stubbed extractor injected through opts.__parseAttestation.
const FAKE_CRED_ID = new Uint8Array([1, 2, 3, 4]);

beforeEach(() => {
  (globalThis as any).navigator = {
    credentials: {
      create: vi.fn().mockResolvedValue({
        type: 'public-key',
        rawId: FAKE_CRED_ID.buffer,
        response: { attestationObject: new Uint8Array([9, 9]).buffer, clientDataJSON: new Uint8Array([1]).buffer },
        getClientExtensionResults: () => ({}),
      }),
    },
  };
  (globalThis as any).window = globalThis;
  (globalThis as any).PublicKeyCredential = function () {};
});

describe('enrollPasskey', () => {
  it('runs create(), returns a 16-byte userHandle + credentialId + base64 pubkey', async () => {
    const res = await enrollPasskey({
      rpId: 'dexter.cash',
      rpName: 'Dexter',
      userName: 'vault-user',
      // Inject the attestation->pubkey extractor so the test does not need a real authenticator.
      __parseAttestation: () => new Uint8Array(33).fill(2),
    });
    expect(res.userHandle).toHaveLength(16);
    expect(Buffer.from(res.credentialId).equals(Buffer.from(FAKE_CRED_ID))).toBe(true);
    expect(typeof res.publicKeyBase64).toBe('string');
    expect((globalThis as any).navigator.credentials.create).toHaveBeenCalledTimes(1);
  });

  it('throws a typed error in a non-browser environment', async () => {
    delete (globalThis as any).PublicKeyCredential;
    await expect(
      enrollPasskey({ rpId: 'dexter.cash', rpName: 'Dexter', userName: 'u', __parseAttestation: () => new Uint8Array(33) }),
    ).rejects.toThrow(/browser|webauthn/i);
  });
});
