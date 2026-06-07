/**
 * verifyConnectProof — the relying-app VERIFIER for "Connect a Tab" step 1.
 *
 * These tests exercise the verifier's ASSEMBLY + DECISION logic offline by
 * injecting a fake `simulate`. The real verifier (prod) defaults `simulate` to
 * the live `connection.simulateTransaction`; the on-chain semantics are what
 * actually reject a forged proof. Here we drive the err value directly so the
 * decision branch ("err === null") is tested deterministically without a network.
 *
 * The crypto bytes in the fixture do NOT need to be real (simulate is faked);
 * they only need correct LENGTHS so the instruction builders don't throw.
 */
import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { verifyConnectProof, type ConnectProof, type SimulateFn } from '../src/connect/index.js';

// ── Fixtures ──────────────────────────────────────────────────────────────

// A real base58 PublicKey for the vault (any valid one works — never dereffed).
const VAULT = '11111111111111111111111111111111';

// The relying-app challenge, base64url of 32 raw bytes (the canonical contract).
function makeChallenge(): string {
  const raw = new Uint8Array(32).fill(0x42);
  return Buffer.from(raw).toString('base64url');
}

function makeProof(overrides: Partial<ConnectProof> = {}): ConnectProof {
  return {
    passkeyPubkey: new Uint8Array(33).fill(0x02), // 33-byte compressed P-256
    vault: VAULT,
    clientDataJSON: new TextEncoder().encode(
      '{"type":"webauthn.get","challenge":"3q2-7w","origin":"https://dexter.cash"}',
    ),
    authenticatorData: new Uint8Array(37).fill(0x99),
    signature: new Uint8Array(64).fill(0x11), // 64-byte compact r||s
    ...overrides,
  };
}

// A connection stub — never actually used because we inject `simulate`.
const fakeConnection = {} as never;

describe('verifyConnectProof', () => {
  it('valid proof → simulate err === null → ok true, vault echoed', async () => {
    const simulate: SimulateFn = async () => ({ value: { err: null } });
    const res = await verifyConnectProof({
      connection: fakeConnection,
      challenge: makeChallenge(),
      proof: makeProof(),
      simulate,
    });
    expect(res.ok).toBe(true);
    expect(res.vault).toBeInstanceOf(PublicKey);
    expect(res.vault?.toBase58()).toBe(new PublicKey(VAULT).toBase58());
  });

  it('forged / wrong passkey → simulate returns InstructionError → ok false', async () => {
    const simulate: SimulateFn = async () => ({
      value: { err: { InstructionError: [0, 'Custom'] } },
    });
    const res = await verifyConnectProof({
      connection: fakeConnection,
      challenge: makeChallenge(),
      proof: makeProof(),
      simulate,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBeDefined();
  });

  it('wrong challenge → simulate returns an err → ok false', async () => {
    const simulate: SimulateFn = async () => ({
      value: { err: { InstructionError: [1, { Custom: 6001 }] } },
    });
    const res = await verifyConnectProof({
      connection: fakeConnection,
      challenge: makeChallenge(),
      proof: makeProof(),
      simulate,
    });
    expect(res.ok).toBe(false);
  });

  it('malformed proof (5-byte passkey) → ok false with reason, no throw, no simulate', async () => {
    let simulateCalled = false;
    const simulate: SimulateFn = async () => {
      simulateCalled = true;
      return { value: { err: null } };
    };
    const res = await verifyConnectProof({
      connection: fakeConnection,
      challenge: makeChallenge(),
      proof: makeProof({ passkeyPubkey: new Uint8Array(5).fill(0x02) }),
      simulate,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBeDefined();
    expect(simulateCalled).toBe(false);
  });

  it('malformed vault base58 → ok false with reason, no throw', async () => {
    const simulate: SimulateFn = async () => ({ value: { err: null } });
    const res = await verifyConnectProof({
      connection: fakeConnection,
      challenge: makeChallenge(),
      proof: makeProof({ vault: 'not-a-valid-base58-pubkey-0OIl' }),
      simulate,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBeDefined();
  });
});
