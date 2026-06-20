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

const AUTH_OP_MESSAGE = new Uint8Array([100, 101, 102, 103]);

describe('DexterApiBrowserPasskeySigner', () => {
  it('signOperation() hashes the op, mints a challenge bound to sha256(op), asserts over the server challenge, verifies', async () => {
    const opHash = await sha256(AUTH_OP_MESSAGE);
    // Server uses the operationHash AS the challenge (dexter-fe + webauthn.rs law).
    const policy = {
      issueChallenge: vi.fn().mockImplementation(async ({ operationHash }: { operationHash: Uint8Array }) => operationHash),
      verify: vi.fn().mockResolvedValue(undefined),
    };
    const assertion = fakeAssertion();
    const signer = new DexterApiBrowserPasskeySigner({ credentialId: CRED, publicKey: PUB, policy, __assertion: assertion });

    const out = await signer.signOperation(AUTH_OP_MESSAGE);

    // issueChallenge bound to credentialId + sha256(op).
    expect(policy.issueChallenge).toHaveBeenCalledTimes(1);
    const mintArg = policy.issueChallenge.mock.calls[0]![0] as { credentialId: Uint8Array; operationHash: Uint8Array };
    expect(mintArg.credentialId).toBe(CRED);
    expect(Array.from(mintArg.operationHash)).toEqual(Array.from(opHash));

    // MONEY-PATH INVARIANT: the challenge the assertion ran over === sha256(operationMessage).
    expect(assertion.assertOver).toHaveBeenCalledTimes(1);
    expect(Array.from(assertion.assertOver.mock.calls[0]![0] as Uint8Array)).toEqual(Array.from(opHash));

    expect(out.signature).toBeInstanceOf(Uint8Array);
    expect(out.signature).toHaveLength(64);
    expect(out.clientDataJSON).toBeInstanceOf(Uint8Array);
    expect(policy.verify).toHaveBeenCalledTimes(1);
  });

  it('exposes credentialId (PasskeySigner contract)', () => {
    const policy = { issueChallenge: vi.fn(), verify: vi.fn() };
    const signer = new DexterApiBrowserPasskeySigner({ credentialId: CRED, publicKey: PUB, policy, __assertion: fakeAssertion() });
    expect(signer.credentialId).toBe(CRED);
  });
});

// ── Guest (ANON) path ──────────────────────────────────────────────────────

const USER_HANDLE = new Uint8Array(16).fill(7);
const OP_MESSAGE = new Uint8Array([10, 20, 30]);

describe('DexterApiBrowserPasskeySigner — guest (ANON) path', () => {
  it('signOperation() mints with {userHandle, operationHash}, asserts over the server challenge, verifies with {credential, userHandle}', async () => {
    const serverChallenge = new Uint8Array(32).fill(5);
    const opHash = await sha256(OP_MESSAGE);

    const anonPolicy = {
      issueChallenge: vi.fn().mockResolvedValue({
        challenge: serverChallenge,
        credentialId: CRED,
        rpId: 'dexter.cash',
        transports: ['internal'] as AuthenticatorTransport[],
      }),
      verify: vi.fn().mockResolvedValue(undefined),
    };
    const assertion = fakeAssertion();

    const signer = new DexterApiBrowserPasskeySigner({
      identity: { kind: 'guest', userHandle: USER_HANDLE },
      publicKey: PUB,
      anonPolicy,
      __assertion: assertion,
    });

    const out = await signer.signOperation(OP_MESSAGE);

    // Mint bound to userHandle + the sha256(op) operationHash.
    expect(anonPolicy.issueChallenge).toHaveBeenCalledTimes(1);
    const mintArg = anonPolicy.issueChallenge.mock.calls[0]![0] as {
      userHandle: Uint8Array;
      operationHash: Uint8Array;
    };
    expect(mintArg.userHandle).toBe(USER_HANDLE);
    expect(Array.from(mintArg.operationHash)).toEqual(Array.from(opHash));

    // Assertion ran over the SERVER-issued challenge (not the op hash).
    expect(assertion.assertOver).toHaveBeenCalledTimes(1);
    expect(Array.from(assertion.assertOver.mock.calls[0]![0] as Uint8Array)).toEqual(
      Array.from(serverChallenge),
    );

    // Verify keyed on {credential bytes, userHandle}.
    expect(anonPolicy.verify).toHaveBeenCalledTimes(1);
    const verifyArg = anonPolicy.verify.mock.calls[0]![0] as {
      userHandle: Uint8Array;
      credentialId: Uint8Array;
    };
    expect(verifyArg.userHandle).toBe(USER_HANDLE);
    expect(verifyArg.credentialId).toBe(CRED);

    // Returns the three on-chain-ready Uint8Array fields.
    expect(out.signature).toBeInstanceOf(Uint8Array);
    expect(out.signature).toHaveLength(64);
    expect(out.clientDataJSON).toBeInstanceOf(Uint8Array);
    expect(out.authenticatorData).toBeInstanceOf(Uint8Array);
  });

  it('exposes the guest publicKey (33-byte SEC1) for the on-chain verifier', () => {
    const anonPolicy = { issueChallenge: vi.fn(), verify: vi.fn() };
    const signer = new DexterApiBrowserPasskeySigner({
      identity: { kind: 'guest', userHandle: USER_HANDLE },
      publicKey: PUB,
      anonPolicy,
      __assertion: fakeAssertion(),
    });
    expect(signer.publicKey).toBe(PUB);
  });

  it('guest signOperation() surfaces the server-resolved credentialId on credentialId', async () => {
    const anonPolicy = {
      issueChallenge: vi.fn().mockResolvedValue({
        challenge: new Uint8Array(32).fill(5),
        credentialId: CRED,
      }),
      verify: vi.fn().mockResolvedValue(undefined),
    };
    const signer = new DexterApiBrowserPasskeySigner({
      identity: { kind: 'guest', userHandle: USER_HANDLE },
      publicKey: PUB,
      anonPolicy,
      __assertion: fakeAssertion(),
    });
    await signer.signOperation(OP_MESSAGE);
    expect(signer.credentialId).toBe(CRED);
  });
});

// Local sha256 mirroring the SDK's (jsdom provides window.crypto.subtle).
async function sha256(buf: Uint8Array): Promise<Uint8Array> {
  const out = await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(buf));
  return new Uint8Array(out);
}
