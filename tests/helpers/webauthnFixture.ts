/**
 * Realistic WebAuthn ceremony fixture — the test-side twin of the browser
 * assertion (and of dexter-vault/tests/helpers/secp256r1.ts's
 * signOperationWithPasskey). Produces byte-realistic clientDataJSON /
 * authenticatorData / signature triples so unit tests exercise the REAL
 * challenge-binding contract (clientDataJSON.challenge = base64url(
 * sha256(operationMessage))) instead of placeholder bytes, and so the
 * tx-size measurement uses production-shaped payload sizes:
 *   clientDataJSON  ≈ 134 B  ({"type","challenge","origin","crossOrigin"})
 *   authenticatorData = 37 B (rpIdHash ‖ flags ‖ signCount)
 */
import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha256';

const RP_ID = 'dexter.cash';

export interface TestPasskey {
  privateKey: Uint8Array;
  /** 33-byte SEC1 compressed P-256 public key (the form the vault stores). */
  publicKey: Uint8Array;
}

export function generateTestPasskey(): TestPasskey {
  const privateKey = p256.utils.randomPrivateKey();
  const publicKey = p256.getPublicKey(privateKey, true);
  return { privateKey, publicKey };
}

function base64url(input: Uint8Array): string {
  return Buffer.from(input).toString('base64url');
}

/** Minimal valid authenticatorData: rpIdHash(32) ‖ flags UP|UV(1) ‖ signCount(4). */
export function buildAuthenticatorData(signCount = 1): Uint8Array {
  const out = new Uint8Array(37);
  out.set(sha256(new TextEncoder().encode(RP_ID)), 0);
  out[32] = 0x05;
  new DataView(out.buffer).setUint32(33, signCount, false);
  return out;
}

export interface SignedCeremonyFixture {
  clientDataJSON: Uint8Array;
  authenticatorData: Uint8Array;
  /** 64-byte compact (r‖s) lowS over authenticatorData ‖ sha256(clientDataJSON). */
  signature: Uint8Array;
}

/**
 * Simulate the full on-chain-op WebAuthn ceremony: the challenge is
 * sha256(operationMessage) (the webauthn.rs law), the signature covers the
 * SIMD-0075 precompile message authenticatorData ‖ sha256(clientDataJSON).
 * Pass `extraClientData` to fatten clientDataJSON (browser-variance sizing
 * for the tx-size measurement).
 */
export function signOperationFixture(
  passkey: TestPasskey,
  operationMessage: Uint8Array,
  extraClientData?: Record<string, string>,
): SignedCeremonyFixture {
  const challenge = base64url(sha256(operationMessage));
  const clientDataJSON = new TextEncoder().encode(
    JSON.stringify({
      type: 'webauthn.get',
      challenge,
      origin: `https://${RP_ID}`,
      crossOrigin: false,
      ...(extraClientData ?? {}),
    }),
  );
  const authenticatorData = buildAuthenticatorData();

  const precompileMessage = new Uint8Array(authenticatorData.length + 32);
  precompileMessage.set(authenticatorData, 0);
  precompileMessage.set(sha256(clientDataJSON), authenticatorData.length);

  const signature = p256
    .sign(sha256(precompileMessage), passkey.privateKey, { lowS: true })
    .toCompactRawBytes();

  return { clientDataJSON, authenticatorData, signature };
}
