// src/signers/browser/__tests__/dexterApiSigner.test.ts
import { describe, it, expect, vi } from 'vitest';
import { DexterApiBrowserPasskeySigner } from '../dexterApiSigner.js';

const CRED = new Uint8Array([1, 2, 3]);
const PUB = new Uint8Array(33).fill(2);

function fakeAssertion() {
  return {
    assertOver: vi.fn().mockResolvedValue({
      signature: new Uint8Array(64).fill(9),
      signatureDer: new Uint8Array([48, 0]),
      clientDataJSON: new Uint8Array([1, 2]),
      authenticatorData: new Uint8Array([3, 4]),
    }),
    credentialId: CRED,
  };
}

describe('DexterApiBrowserPasskeySigner', () => {
  it('sign() runs the assertion then verifies with server policy; returns Uint8Array fields', async () => {
    const policy = { issueChallenge: vi.fn(), verify: vi.fn().mockResolvedValue(undefined) };
    const signer = new DexterApiBrowserPasskeySigner({ credentialId: CRED, publicKey: PUB, policy, __assertion: fakeAssertion() });
    const out = await signer.sign(new Uint8Array(32).fill(1));
    expect(out.signature).toBeInstanceOf(Uint8Array);
    expect(out.signature).toHaveLength(64);
    expect(out.clientDataJSON).toBeInstanceOf(Uint8Array);
    expect(policy.verify).toHaveBeenCalledTimes(1);
  });

  it('signWithServerChallenge() fetches the challenge then signs', async () => {
    const policy = {
      issueChallenge: vi.fn().mockResolvedValue(new Uint8Array(32).fill(2)),
      verify: vi.fn().mockResolvedValue(undefined),
    };
    const signer = new DexterApiBrowserPasskeySigner({ credentialId: CRED, publicKey: PUB, policy, __assertion: fakeAssertion() });
    await signer.signWithServerChallenge();
    expect(policy.issueChallenge).toHaveBeenCalledWith({ credentialId: CRED });
    expect(policy.verify).toHaveBeenCalledTimes(1);
  });

  it('exposes credentialId (PasskeySigner contract)', () => {
    const policy = { issueChallenge: vi.fn(), verify: vi.fn() };
    const signer = new DexterApiBrowserPasskeySigner({ credentialId: CRED, publicKey: PUB, policy, __assertion: fakeAssertion() });
    expect(signer.credentialId).toBe(CRED);
  });
});
