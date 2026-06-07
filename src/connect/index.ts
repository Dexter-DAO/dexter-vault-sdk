/**
 * @dexterai/vault/connect — the relying-app side of "Connect a Tab".
 *
 * Step 1 (auth): a third-party app verifies a user controls a named Dexter
 * vault by checking a prove_passkey proof, via verifyConnectProof. The verifier
 * simulates the read-only [secp256r1_verify, prove_passkey] transaction — the
 * canonical on-chain method — so it reuses the exact P-256 semantics rather
 * than re-implementing verification.
 */
export { verifyConnectProof, decodeChallengeTo32Bytes } from './verify.js';
export type { ConnectProof, ConnectVerifyResult, SimulateFn } from './verify.js';
