#!/usr/bin/env node
/**
 * prove-step4-lock-mode.mjs — Step-4 LOCK-MODE end-to-end mainnet proof harness.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  ⚠️  THIS SPENDS REAL MAINNET USDC.  DO NOT RUN WITHOUT THE OWNER'S GO.  ⚠️
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Dexter is MAINNET-ONLY (there is no devnet). Every transaction this script
 * sends lands on Solana mainnet-beta and moves real USDC. The script is
 * HARD-GATED: without the explicit flag `--i-have-the-owners-go` it STOPS at a
 * preflight dry-run (prints the plan, the resolved keys, the funding check) and
 * never sends a write. The gated run is a SEPARATE, owner-authorized step.
 *
 * WHAT THIS PROVES (the full lock-mode lifecycle, SDK-direct, asserted on-chain)
 *   1. Fresh MARKER-ENROLLED vault. A counterfactual vault is created via
 *      buildSwigCreationBundle — whose creation bundle now carries the
 *      `settle_locked_voucher` ProgramExec marker (T1) — then ACTIVATED with a
 *      software-key passkey set_swig ceremony (the proven activation pattern
 *      from proof-of-firstuse). Vault must be USDC-funded first (see
 *      PREREQUISITES); the script checks the balance and errors clearly if not.
 *   2. Open + session. A per-counterparty ed25519 session key (the buyer's
 *      signing key) is registered against a test seller counterparty.
 *   3. Stream + sign a voucher. The session key Ed25519-signs the canonical
 *      44-byte voucher message channel_id(32)‖cumulative(u64-LE)‖seq(u32-LE).
 *   4. Crystallize (lock_voucher). buildLockVoucherInstruction is submitted with
 *      the Ed25519 precompile verify ix preceding it. ASSERT: the claim is now
 *      Pending in fetchVaultLockedClaims(...,{status:'Pending'}), the vault's
 *      outstandingLockedAmount rose by the crystallized delta, and
 *      sum(Pending amounts) === outstandingLockedAmount.
 *   5. Reservation guard. A finalize_withdrawal that would breach the
 *      reservation (withdraw more than balance − outstandingLockedAmount) is
 *      attempted. ASSERT it is REJECTED by the program with
 *      WithdrawalWouldViolateReservation. The expected rejection is treated as
 *      SUCCESS (this is the on-chain anti-rug proof).
 *   6. Settle. buildInstantPayoutInstructions builds the locked-claim payout
 *      (financierSpread 0n → 100% to the seller's USDC ATA; financier = holder;
 *      dexterAuthority = master). ASSERT: the seller ATA rose by the claim
 *      amount, the claim flips to Settled (gone from the Pending enumeration),
 *      and outstandingLockedAmount returns to its pre-lock value (→ 0 if it was
 *      the only claim).
 *
 * WHY a software P-256 key can drive activation: the only thing the on-chain
 * secp256r1 precompile ever checks is a signature over a known message plus a
 * challenge-hash match — which a software key produces identically to a real
 * passkey (the same ceremony proof-of-firstuse uses). No biometric, no WebAuthn
 * attestation is verified on this path.
 *
 * GROUNDING — this harness mirrors, byte-for-byte where it matters:
 *   - dexter-x402-sdk/scripts/proof-of-firstuse.mjs   (software-passkey activate
 *     + register flow, funding check, RPC-from-env discipline, receipt logging)
 *   - dexter-vault/tests/lock-voucher.ts              (open-tab → session-signed
 *     voucher → lock_voucher submit shape; sellerHolder/dexterAuthority/payer)
 *   - dexter-vault/tests/finalize-withdrawal-reservation.ts (request_withdrawal
 *     → finalize_withdrawal → expect WithdrawalWouldViolateReservation)
 *   - dexter-vault/tests/locked-claim-settle.ts       (settle_locked_voucher +
 *     Swig SignV2 payout; holder signs; outstanding/settle accumulator deltas)
 *   It uses the PUBLISHED SDK builders directly (no anchor, no @dexterai/x402,
 *   no pg) since dexter-vault-sdk ships them all.
 *
 * RUN-TIME PREREQUISITES (the gated run is turnkey once these hold):
 *   ENV
 *     SOLANA_RPC_URL          REQUIRED — write-capable mainnet RPC. (Fallbacks
 *                             RPC_URL / HELIUS_RPC_URL.) NEVER hardcode it.
 *     STEP4_FEE_PAYER_KEY     path to a Solana keypair JSON (64-byte secret) OR
 *                             base58 secret. Pays all fees + ATA rent + funds
 *                             the vault. Needs SOL and (if auto-funding the
 *                             vault) USDC. Default scans the standard funder
 *                             keys (see FUNDER_CANDIDATES).
 *     STEP4_MASTER_KEY        the Dexter session-master keypair = the vault's
 *                             dexter_authority AND the HMAC source for the swig
 *                             id. JSON 64-byte secret / 32-byte seed / base58.
 *                             (Production stores this encrypted in
 *                             DEXTER_SESSION_MASTER_KEY; this harness wants the
 *                             raw keypair so it can SIGN as dexter_authority.)
 *     STEP4_HOLDER_KEY        OPTIONAL — the test holder/financier keypair (the
 *                             lock-mode claim holder who collects at settle).
 *                             Generated fresh if unset (printed so it can be
 *                             reused / funded).
 *     STEP4_SELLER            OPTIONAL — base58 seller counterparty pubkey; the
 *                             seller's USDC ATA receives the settle payout.
 *                             Generated fresh if unset.
 *     STEP4_FUND_USDC_ATOMIC  OPTIONAL — atomic USDC to seed the vault with
 *                             (default 20000 = $0.02). Must be ≤ fee-payer USDC.
 *   ON-CHAIN
 *     - fee payer funded with SOL (fees + several ATA rents ≈ 0.01 SOL) and,
 *       if auto-funding, with USDC ≥ STEP4_FUND_USDC_ATOMIC.
 *     - the seller USDC ATA is created idempotently by the script (fee payer
 *       pays rent), so the seller need not pre-exist.
 *
 * Verify-only (what THIS task did): `node --check scripts/prove-step4-lock-mode.mjs`.
 * The harness body is NEVER executed against mainnet here.
 */

import { readFileSync, existsSync } from 'node:fs';
import crypto from 'node:crypto';

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
} from '@solana/spl-token';
import { p256 } from '@noble/curves/p256';
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import bs58 from 'bs58';

// ── SDK entry points (dist — exactly how a published consumer imports) ───────
import {
  buildSwigCreationBundle,
  buildInitializeVaultInstruction,
  buildSetSwigInstruction,
  buildRegisterSessionKeyInstruction,
  buildSettleVoucherInstruction,
  buildLockVoucherInstruction,
  deriveLockedClaimPda,
  buildRequestWithdrawalInstruction,
  buildFinalizeWithdrawalInstruction,
  deriveVaultPda,
  deriveSwigWalletAddress,
} from '../dist/instructions/index.js';
import { buildInstantPayoutInstructions } from '../dist/factoring/index.js';
import { buildVoucherMessage, sessionRegisterMessage, buildSetSwigOperationMessage } from '../dist/messages/index.js';
import { buildEd25519VerifyInstruction, buildSecp256r1VerifyInstruction } from '../dist/precompile/index.js';
import { readVaultFull, fetchVaultLockedClaims } from '../dist/reader/index.js';
import { deriveSessionPda } from '../dist/session/index.js';
import { DEXTER_VAULT_PROGRAM_ID, USDC_MAINNET } from '../dist/constants/index.js';

// ── Constants ────────────────────────────────────────────────────────────────
const USDC_MINT = new PublicKey(USDC_MAINNET);
const USDC_DECIMALS = 6;
const DEFAULT_FUND_USDC_ATOMIC = 20_000n; // $0.02 — tiny; lock is $0.01, leaves headroom
const LOCK_AMOUNT_ATOMIC = 10_000n; // $0.01 crystallized claim
const COOLING_OFF_SECONDS = 0; // fresh vault: 0 so the reservation guard (not the
//                                cooling-off guard) is the one that fires at finalize

const DEXTER_API_ENV = '/home/branchmanager/websites/dexter-api/.env';
const FUNDER_CANDIDATES = [
  `${process.env.HOME}/.config/solana/dexter-proof-seller.json`,
  '/home/branchmanager/.config/solana/dexter-vault/upgrade-authority.json',
];

const GO_FLAG = '--i-have-the-owners-go';
const HARD_GATE = process.argv.includes(GO_FLAG);

const log = (...a) => console.log('[step4]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (u8) => Buffer.from(u8).toString('base64');

let STEP = 'preflight';
const receipts = { startedAt: new Date().toISOString(), txSignatures: {} };
const assertions = [];
function assert(cond, label, detail) {
  const ok = !!cond;
  assertions.push({ label, ok, detail: detail ?? null });
  console.log(`  ${ok ? 'PASS' : 'FAIL'} — ${label}${detail ? ` (${detail})` : ''}`);
  if (!ok) throw new Error(`ASSERTION FAILED: ${label}${detail ? ` (${detail})` : ''}`);
}

// ── RPC strictly from env (throw if unset; NEVER hardcode) ───────────────────
function resolveRpcUrl() {
  const direct =
    process.env.SOLANA_RPC_URL || process.env.RPC_URL || process.env.HELIUS_RPC_URL;
  if (direct) return direct;
  // Optional convenience fallback used by the sibling proofs on the operator
  // box: read dexter-api/.env's SOLANA_RPC_ENDPOINT. Still env/file — never a
  // literal in this repo.
  if (existsSync(DEXTER_API_ENV)) {
    const m = readFileSync(DEXTER_API_ENV, 'utf8').match(/^SOLANA_RPC_ENDPOINT=(.+)$/m);
    if (m) return m[1].trim();
  }
  throw new Error(
    'No RPC endpoint set. Export SOLANA_RPC_URL (or RPC_URL / HELIUS_RPC_URL). ' +
      'NEVER hardcode an RPC URL or key — it must come from env.',
  );
}

// ── Keypair loading (JSON 64-byte / 32-byte seed / base58) ───────────────────
function keypairFromRaw(raw, label) {
  const trimmed = raw.trim();
  let secret;
  if (trimmed.startsWith('[')) secret = Uint8Array.from(JSON.parse(trimmed));
  else secret = bs58.decode(trimmed);
  if (secret.length === 64) return Keypair.fromSecretKey(secret);
  if (secret.length === 32) return Keypair.fromSeed(secret);
  throw new Error(`${label}: secret must be 32 or 64 bytes, got ${secret.length}`);
}
function loadKeypairFromEnvOrFile(envName, label, { required = true } = {}) {
  const v = process.env[envName];
  if (!v) {
    if (required) throw new Error(`${envName} is required (${label}).`);
    return null;
  }
  if (existsSync(v)) return keypairFromRaw(readFileSync(v, 'utf8'), label);
  return keypairFromRaw(v, label);
}

async function usdcBalance(conn, owner) {
  const ata = getAssociatedTokenAddressSync(USDC_MINT, owner, true);
  try {
    return BigInt((await conn.getTokenAccountBalance(ata)).value.amount);
  } catch {
    return null;
  }
}

// ── Software-passkey ceremony (inlined; identical to
//    @dexterai/x402 tab/adapters/solana passkey-noble.signOperationWithPasskey,
//    which is NOT a dependency of this repo). The on-chain handler verifies the
//    secp256r1 precompile over authenticatorData‖sha256(clientDataJSON) and then
//    checks the clientDataJSON challenge == sha256(operationMessage). ───────────
function b64url(u8) {
  return Buffer.from(u8).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function buildClientDataJSON(challenge) {
  const json = JSON.stringify({
    type: 'webauthn.get',
    challenge: b64url(challenge),
    origin: 'https://dexter.cash',
    crossOrigin: false,
  });
  return new TextEncoder().encode(json);
}
function buildAuthenticatorData(signCount) {
  // 32-byte rpIdHash ‖ 1-byte flags (UP=0x01|UV=0x04) ‖ 4-byte signCount (BE).
  const rpIdHash = sha256(new TextEncoder().encode('dexter.cash'));
  const out = new Uint8Array(37);
  out.set(rpIdHash, 0);
  out[32] = 0x05;
  out[33] = (signCount >>> 24) & 0xff;
  out[34] = (signCount >>> 16) & 0xff;
  out[35] = (signCount >>> 8) & 0xff;
  out[36] = signCount & 0xff;
  return out;
}
function signOperationWithPasskey(p256Priv, operationMessage) {
  const challenge = sha256(operationMessage);
  const clientDataJSON = buildClientDataJSON(challenge);
  const authenticatorData = buildAuthenticatorData(1);
  const precompileMessage = new Uint8Array(authenticatorData.length + 32);
  precompileMessage.set(authenticatorData, 0);
  precompileMessage.set(sha256(clientDataJSON), authenticatorData.length);
  const sig = p256.sign(sha256(precompileMessage), p256Priv, { lowS: true });
  return { clientDataJSON, authenticatorData, precompileMessage, signature: sig.toCompactRawBytes() };
}

// ── request_withdrawal / finalize_withdrawal op-message builders.
//    NOT exported by the SDK (they live only in dexter-vault's test helpers),
//    so they are reconstructed here from request_withdrawal.rs / the on-chain
//    op_msg layout:
//      request:  "request_withdrawal" ‖ amount(u64-LE) ‖ destination(32) ‖ signed_at(i64-LE)
//      finalize: "finalize_withdrawal" ‖ amount(u64-LE) ‖ destination(32)
//    (FLAGGED for the gated run: confirm finalizeWithdrawalMessage matches the
//    deployed finalize_withdrawal.rs op_msg byte-for-byte before relying on it.)
function requestWithdrawalMessage(amount, destination, signedAt) {
  const prefix = Buffer.from('request_withdrawal', 'utf8');
  const out = Buffer.alloc(prefix.length + 8 + 32 + 8);
  let o = 0;
  prefix.copy(out, o); o += prefix.length;
  out.writeBigUInt64LE(amount, o); o += 8;
  Buffer.from(destination.toBytes()).copy(out, o); o += 32;
  out.writeBigInt64LE(signedAt, o); o += 8;
  return new Uint8Array(out);
}
function finalizeWithdrawalMessage(amount, destination) {
  const prefix = Buffer.from('finalize_withdrawal', 'utf8');
  const out = Buffer.alloc(prefix.length + 8 + 32);
  let o = 0;
  prefix.copy(out, o); o += prefix.length;
  out.writeBigUInt64LE(amount, o); o += 8;
  Buffer.from(destination.toBytes()).copy(out, o); o += 32;
  return new Uint8Array(out);
}

// ── tx helper: build, sign with the given keypairs, send, confirm, return sig ─
async function sendAndConfirm(conn, ixs, feePayerKp, signers) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = feePayerKp.publicKey;
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  const allSigners = [feePayerKp, ...signers.filter((s) => !s.publicKey.equals(feePayerKp.publicKey))];
  tx.sign(...allSigners);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  const conf = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  if (conf.value?.err) throw new Error(`tx ${sig} confirmed with error: ${JSON.stringify(conf.value.err)}`);
  return sig;
}

async function main() {
  const rpcUrl = resolveRpcUrl(); // throws first if unset
  const conn = new Connection(rpcUrl, 'confirmed');

  // ── Resolve identities ──────────────────────────────────────────────────
  STEP = 'STEP 0 (preflight)';
  log('═══ STEP 0 — preflight + key resolution ═══');

  // Fee payer: explicit env, else scan the standard funder candidates.
  let feePayer = loadKeypairFromEnvOrFile('STEP4_FEE_PAYER_KEY', 'fee payer', { required: false });
  if (!feePayer) {
    let bestSol = -1;
    for (const path of FUNDER_CANDIDATES) {
      if (!existsSync(path)) continue;
      const kp = keypairFromRaw(readFileSync(path, 'utf8'), 'funder candidate');
      const sol = await conn.getBalance(kp.publicKey);
      if (sol > bestSol) {
        bestSol = sol;
        feePayer = kp;
      }
    }
    if (!feePayer) {
      throw new Error('No fee payer: set STEP4_FEE_PAYER_KEY or provide a funder candidate keyfile.');
    }
  }

  // Master = dexter_authority (signs init / openTab / lock / settle as authority)
  // AND the HMAC source for the swig id (first 32 bytes of its secret) — exactly
  // what dexter-api does: getSessionMasterKeypair().secretKey.subarray(0,32).
  const master = loadKeypairFromEnvOrFile('STEP4_MASTER_KEY', 'dexter master / session-master');
  const hmacKey = master.secretKey.subarray(0, 32);

  // Holder = the lock-mode claim holder / financier (collects at settle).
  const holder = loadKeypairFromEnvOrFile('STEP4_HOLDER_KEY', 'holder / financier', { required: false }) ?? Keypair.generate();
  // Seller counterparty (its USDC ATA receives the payout).
  const seller = process.env.STEP4_SELLER ? new PublicKey(process.env.STEP4_SELLER) : Keypair.generate().publicKey;

  // Fresh software P-256 passkey + fresh 16-byte identity (counterfactual vault).
  const p256Priv = p256.utils.randomPrivateKey();
  const passkeyPubkey = p256.getPublicKey(p256Priv, true); // 33-byte SEC1 compressed
  const identitySeed = crypto.randomBytes(16);
  // identity_claim is 32 bytes (16-byte seed, zero-padded) — initialize uses
  // only the leading 16 bytes for the vault PDA seed.
  const identityClaim = new Uint8Array(32);
  identityClaim.set(identitySeed, 0);
  const { pda: vaultPda } = deriveVaultPda(identitySeed);

  const fundAmount = process.env.STEP4_FUND_USDC_ATOMIC
    ? BigInt(process.env.STEP4_FUND_USDC_ATOMIC)
    : DEFAULT_FUND_USDC_ATOMIC;

  log('rpc            :', rpcUrl);
  log('fee payer      :', feePayer.publicKey.toBase58());
  log('master (auth)  :', master.publicKey.toBase58());
  log('holder/financ. :', holder.publicKey.toBase58());
  log('seller         :', seller.toBase58());
  log('vault pda      :', vaultPda.toBase58());
  log('fund amount    :', fundAmount.toString(), 'atomic USDC');
  log('lock amount    :', LOCK_AMOUNT_ATOMIC.toString(), 'atomic USDC');
  Object.assign(receipts, {
    rpc: rpcUrl,
    feePayer: feePayer.publicKey.toBase58(),
    master: master.publicKey.toBase58(),
    holder: holder.publicKey.toBase58(),
    seller: seller.toBase58(),
    vaultPda: vaultPda.toBase58(),
    fundAmountAtomic: fundAmount.toString(),
    lockAmountAtomic: LOCK_AMOUNT_ATOMIC.toString(),
  });

  // Build the swig creation bundle (carries the settle_locked_voucher marker, T1).
  const bundle = await buildSwigCreationBundle({
    feePayer: feePayer.publicKey.toBase58(),
    dexterMasterPubkey: master.publicKey.toBase58(),
    identitySeed,
    hmacKey,
  });
  const swigAddress = new PublicKey(bundle.swigAddress);
  log('swig address   :', swigAddress.toBase58(), `(creation bundle: ${bundle.instructions.length} ix, marker-enrolled)`);
  receipts.swigAddress = swigAddress.toBase58();

  // Funding preflight: fee payer must have SOL for fees+rent, and if we are to
  // auto-fund the vault it must hold the USDC.
  const feeSol = await conn.getBalance(feePayer.publicKey);
  const feeUsdc = (await usdcBalance(conn, feePayer.publicKey)) ?? 0n;
  log('fee payer SOL  :', (feeSol / 1e9).toFixed(5));
  log('fee payer USDC :', feeUsdc.toString());

  if (!HARD_GATE) {
    console.log('\n──────────────────────────────────────────────────────────────────');
    console.log('DRY-RUN (HARD GATE NOT SET). No transaction was sent.');
    console.log(`This script spends REAL mainnet USDC. Re-run with ${GO_FLAG} ONLY`);
    console.log('on the repo owner\'s explicit authorization. Preflight summary:');
    console.log(JSON.stringify({ ...receipts, feeSol: (feeSol / 1e9).toFixed(5), feeUsdc: feeUsdc.toString() }, null, 2));
    return;
  }

  // ── HARD-GATED FROM HERE: real mainnet writes ─────────────────────────────
  if (feeSol < 10_000_000) {
    throw new Error(`fee payer ${feePayer.publicKey.toBase58()} has ${(feeSol / 1e9).toFixed(6)} SOL — need ≥ ~0.01 for fees + ATA rents.`);
  }

  // ── STEP 1 — create + activate the marker-enrolled vault ──────────────────
  STEP = 'STEP 1 (create + activate vault)';
  log('═══ STEP 1 — initialize vault, create swig (marker-enrolled), set_swig ═══');

  // 1a. initialize_vault (fee payer + master sign).
  const initIx = buildInitializeVaultInstruction({
    vaultPda,
    payer: feePayer.publicKey,
    dexterAuthority: master.publicKey,
    passkeyPubkey,
    coolingOffSeconds: COOLING_OFF_SECONDS,
    identityClaim,
  });
  receipts.txSignatures.initialize = await sendAndConfirm(conn, [initIx], feePayer, [master]);
  log('initialize tx  :', receipts.txSignatures.initialize);

  // 1b. create the swig (the marker bundle). Bundle ixs are swig-program ixs;
  //     fee payer signs (role-0 bootstrap). It is the canonical kit output.
  receipts.txSignatures.swigCreate = await sendAndConfirm(
    conn,
    [ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ...bundle.instructions],
    feePayer,
    [],
  );
  log('swig create tx :', receipts.txSignatures.swigCreate);

  // 1c. fund the vault's receive address (swig wallet USDC ATA) BEFORE set_swig
  //     overcommit gates — but the swig wallet PDA only exists after create, so
  //     fund now. The receive address is the swig-wallet-owned USDC ATA. We need
  //     the swig wallet PDA; deriveSessionPda is unrelated — the swig wallet PDA
  //     is what the SDK's instantPayout/finalize derive internally. The funding
  //     destination is getAssociatedTokenAddressSync(USDC, swigWalletPda). The
  //     swig wallet PDA is provided by the swig kit; we re-derive it the same way
  //     the SDK's deriveSwigWalletAddress does (seeds ["swig-wallet-address",
  //     swig_state] under the Swig program) — exposed through readVaultFull /
  //     the lock builder, but we need the ATA here. Compute via the SDK helper.
  const swigWalletPda = deriveSwigWalletAddress(swigAddress);
  const vaultUsdcAta = getAssociatedTokenAddressSync(USDC_MINT, swigWalletPda, true);

  if (feeUsdc < fundAmount) {
    throw new Error(
      `FUNDING BLOCKER: fee payer holds ${feeUsdc} atomic USDC, need ${fundAmount} to seed the vault. ` +
        `Fund the fee payer (or lower STEP4_FUND_USDC_ATOMIC) and re-run.`,
    );
  }
  const feeUsdcAta = getAssociatedTokenAddressSync(USDC_MINT, feePayer.publicKey, true);
  const fundIxs = [
    createAssociatedTokenAccountIdempotentInstruction(feePayer.publicKey, vaultUsdcAta, swigWalletPda, USDC_MINT),
    createTransferCheckedInstruction(feeUsdcAta, USDC_MINT, vaultUsdcAta, feePayer.publicKey, fundAmount, USDC_DECIMALS),
  ];
  receipts.txSignatures.fund = await sendAndConfirm(conn, fundIxs, feePayer, []);
  log('fund tx        :', receipts.txSignatures.fund);
  // Poll for read-replica visibility.
  let vaultBal = 0n;
  for (let i = 0; i < 20 && vaultBal < fundAmount; i++) {
    vaultBal = (await usdcBalance(conn, swigWalletPda)) ?? 0n;
    if (vaultBal < fundAmount) await sleep(1500);
  }
  assert(vaultBal >= fundAmount, 'vault USDC funded', `${vaultBal} ≥ ${fundAmount}`);
  receipts.vaultUsdcBalance = vaultBal.toString();

  // 1d. ACTIVATE: set_swig (passkey signs the set_swig op message; secp256r1
  //     precompile sibling precedes the vault ix).
  const setSwigMsg = buildSetSwigOperationMessage(swigAddress.toBase58());
  const setSwigCeremony = signOperationWithPasskey(p256Priv, setSwigMsg);
  const setSwigPrecompile = buildSecp256r1VerifyInstruction(
    passkeyPubkey,
    setSwigCeremony.signature,
    setSwigCeremony.precompileMessage,
  );
  const setSwigIx = buildSetSwigInstruction({
    vaultPda,
    swigAddress,
    clientDataJSON: setSwigCeremony.clientDataJSON,
    authenticatorData: setSwigCeremony.authenticatorData,
  });
  receipts.txSignatures.setSwig = await sendAndConfirm(conn, [setSwigPrecompile, setSwigIx], feePayer, []);
  log('set_swig tx    :', receipts.txSignatures.setSwig);

  // Assert the vault is bound + reports the marker-enrolled swig + the master.
  let vaultFull = await readVaultFull(conn, vaultPda);
  for (let i = 0; i < 20 && (!vaultFull.exists || !vaultFull.swigAddress); i++) {
    await sleep(1500);
    vaultFull = await readVaultFull(conn, vaultPda);
  }
  assert(vaultFull.exists && vaultFull.swigAddress === swigAddress.toBase58(), 'vault activated + swig bound',
    `swig=${vaultFull.swigAddress}`);
  assert(vaultFull.dexterAuthority === master.publicKey.toBase58(), 'dexter_authority == master',
    vaultFull.dexterAuthority);
  const outstandingPreLock = BigInt(vaultFull.outstandingLockedAmount);

  // ── STEP 2 — register a per-counterparty session key ──────────────────────
  STEP = 'STEP 2 (register session)';
  log('═══ STEP 2 — register the buyer session key for the seller counterparty ═══');
  const sessionKp = Keypair.generate(); // the buyer's ed25519 signing key
  const sessionPubkey = sessionKp.publicKey.toBytes();
  const nonce = Math.floor(Date.now() / 1000) >>> 0;
  const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 7 * 86400);
  const sessionCap = fundAmount; // cap == funded; overcommit gate (cap + 0 ≤ balance) holds
  const maxRevolving = fundAmount;

  const registerMsg = sessionRegisterMessage({
    programId: DEXTER_VAULT_PROGRAM_ID,
    vaultPda,
    sessionPubkey,
    maxAmount: sessionCap,
    expiresAt,
    allowedCounterparty: seller,
    nonce,
    maxRevolvingCapacity: maxRevolving,
  });
  const regCeremony = signOperationWithPasskey(p256Priv, registerMsg);
  const regPrecompile = buildSecp256r1VerifyInstruction(
    passkeyPubkey,
    regCeremony.signature,
    regCeremony.precompileMessage,
  );
  const registerIx = buildRegisterSessionKeyInstruction({
    vaultPda,
    sessionPubkey,
    maxAmount: sessionCap,
    expiresAt,
    allowedCounterparty: seller,
    nonce,
    maxRevolvingCapacity: maxRevolving,
    swigAddress,
    vaultUsdcAta,
    payer: feePayer.publicKey,
    siblingSessionPdas: [], // fresh vault: no prior live sessions
    clientDataJSON: regCeremony.clientDataJSON,
    authenticatorData: regCeremony.authenticatorData,
  });
  receipts.txSignatures.registerSession = await sendAndConfirm(conn, [regPrecompile, registerIx], feePayer, []);
  log('register tx    :', receipts.txSignatures.registerSession);
  const [sessionPda] = deriveSessionPda(vaultPda, seller);
  log('session pda    :', sessionPda.toBase58());
  receipts.sessionPda = sessionPda.toBase58();

  // ── STEP 3 — open the tab (settle_voucher increment) + sign the voucher ────
  STEP = 'STEP 3 (open tab + sign voucher)';
  log('═══ STEP 3 — open the tab meter, then session-sign the voucher ═══');
  // open: settle_voucher(increment=true, amount=LOCK) seeds session.current_outstanding
  // so lock_voucher has a meter to graduate (mirrors lock-voucher.ts::openTab).
  const openTabIx = buildSettleVoucherInstruction({
    vaultPda,
    dexterAuthority: master.publicKey,
    allowedCounterparty: seller,
    amount: LOCK_AMOUNT_ATOMIC,
    increment: true,
  });
  receipts.txSignatures.openTab = await sendAndConfirm(conn, [openTabIx], feePayer, [master]);
  log('open tab tx    :', receipts.txSignatures.openTab);

  // Voucher: channelId == vaultPda (the seam convention). Session ed25519-signs
  // the canonical 44-byte message.
  const channelId = vaultPda.toBytes();
  const sequenceNumber = 1;
  const voucherMessage = buildVoucherMessage(channelId, LOCK_AMOUNT_ATOMIC, sequenceNumber);
  const voucherHash = sha256(voucherMessage); // == claim PDA 3rd seed + program-validated hash
  const voucherSignature = ed25519.sign(voucherMessage, sessionKp.secretKey.subarray(0, 32));
  log('voucher signed : 44-byte msg, seq', sequenceNumber, 'cumulative', LOCK_AMOUNT_ATOMIC.toString());

  // ── STEP 4 — crystallize (lock_voucher) ───────────────────────────────────
  STEP = 'STEP 4 (lock_voucher / crystallize)';
  log('═══ STEP 4 — lock_voucher: crystallize the claim ═══');
  const ed25519Verify = buildEd25519VerifyInstruction(sessionPubkey, voucherSignature, voucherMessage);
  const lockIx = buildLockVoucherInstruction({
    vaultPda,
    vaultUsdcAta,
    swigAddress,
    sellerHolder: holder.publicKey,
    dexterAuthority: master.publicKey,
    payer: feePayer.publicKey,
    allowedCounterparty: seller,
    channelId,
    cumulativeAmount: LOCK_AMOUNT_ATOMIC,
    sequenceNumber,
    voucherHash,
    maturityAt: null,
    holderRecoveryAt: null,
  });
  // Signers: holder (sellerHolder), master (dexterAuthority), feePayer (payer).
  receipts.txSignatures.lockVoucher = await sendAndConfirm(
    conn,
    [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ed25519Verify, lockIx],
    feePayer,
    [holder, master],
  );
  log('lock tx        :', receipts.txSignatures.lockVoucher);
  const claimPda = deriveLockedClaimPda(vaultPda, voucherHash);
  log('claim pda      :', claimPda.toBase58());
  receipts.claimPda = claimPda.toBase58();

  // Assert the claim is Pending + outstanding rose by the delta + reconciles.
  let pending = [];
  for (let i = 0; i < 25; i++) {
    pending = await fetchVaultLockedClaims(conn, vaultPda, { status: 'Pending' });
    if (pending.some((c) => c.address === claimPda.toBase58())) break;
    await sleep(2000);
  }
  const ourClaim = pending.find((c) => c.address === claimPda.toBase58());
  assert(!!ourClaim, 'claim is Pending in fetchVaultLockedClaims');
  assert(ourClaim.amount === LOCK_AMOUNT_ATOMIC.toString(), 'claim amount == locked delta',
    `${ourClaim.amount}`);
  vaultFull = await readVaultFull(conn, vaultPda);
  const outstandingAfterLock = BigInt(vaultFull.outstandingLockedAmount);
  assert(outstandingAfterLock === outstandingPreLock + LOCK_AMOUNT_ATOMIC,
    'outstandingLockedAmount rose by crystallized delta',
    `${outstandingPreLock} → ${outstandingAfterLock}`);
  const pendingSum = pending.reduce((acc, c) => acc + BigInt(c.amount), 0n);
  assert(pendingSum === outstandingAfterLock, 'sum(Pending) === outstandingLockedAmount',
    `${pendingSum} == ${outstandingAfterLock}`);

  // ── STEP 5 — reservation guard (must REJECT) ──────────────────────────────
  STEP = 'STEP 5 (reservation guard)';
  log('═══ STEP 5 — finalize_withdrawal that breaches the reservation MUST reject ═══');
  // Attempt to withdraw MORE than (balance − outstandingLockedAmount): withdraw
  // the whole balance, which would leave 0 < outstanding ⇒ violation.
  const withdrawAmount = vaultBal; // > (vaultBal − outstanding) since outstanding > 0
  const destination = Keypair.generate().publicKey;
  const signedAt = BigInt(Math.floor(Date.now() / 1000));

  // request_withdrawal (passkey-signed) first — sets pending_withdrawal.
  const reqMsg = requestWithdrawalMessage(withdrawAmount, destination, signedAt);
  const reqCeremony = signOperationWithPasskey(p256Priv, reqMsg);
  const reqPrecompile = buildSecp256r1VerifyInstruction(passkeyPubkey, reqCeremony.signature, reqCeremony.precompileMessage);
  const requestIx = buildRequestWithdrawalInstruction({
    vaultPda,
    amount: withdrawAmount,
    destination,
    signedAt,
    clientDataJSON: reqCeremony.clientDataJSON,
    authenticatorData: reqCeremony.authenticatorData,
  });
  receipts.txSignatures.requestWithdrawal = await sendAndConfirm(conn, [reqPrecompile, requestIx], feePayer, []);
  log('request wd tx  :', receipts.txSignatures.requestWithdrawal);

  // finalize_withdrawal — MUST be rejected with WithdrawalWouldViolateReservation.
  const finMsg = finalizeWithdrawalMessage(withdrawAmount, destination);
  const finCeremony = signOperationWithPasskey(p256Priv, finMsg);
  const finPrecompile = buildSecp256r1VerifyInstruction(passkeyPubkey, finCeremony.signature, finCeremony.precompileMessage);
  const finalizeIx = buildFinalizeWithdrawalInstruction({
    vaultPda,
    swigAddress,
    vaultUsdcAta,
    clientDataJSON: finCeremony.clientDataJSON,
    authenticatorData: finCeremony.authenticatorData,
  });
  let reservationRejected = false;
  let rejectionDetail = '';
  try {
    await sendAndConfirm(conn, [finPrecompile, finalizeIx], feePayer, []);
  } catch (err) {
    rejectionDetail = String(err?.message ?? err);
    if (/WithdrawalWouldViolateReservation/.test(rejectionDetail)) {
      reservationRejected = true;
    } else {
      // Surface the logs so the gated run can tell apart the reservation reject
      // from an unrelated failure (e.g. cooling-off — must be 0 on this vault).
      reservationRejected = false;
    }
  }
  assert(reservationRejected, 'finalize_withdrawal REJECTED by reservation guard (expected = PASS)',
    rejectionDetail.slice(0, 200));
  receipts.reservationRejection = rejectionDetail.slice(0, 300);

  // ── STEP 6 — settle the locked claim (instant payout, spread 0) ───────────
  STEP = 'STEP 6 (settle locked claim)';
  log('═══ STEP 6 — settle_locked_voucher payout: 100% to seller ATA ═══');
  const sellerAta = getAssociatedTokenAddressSync(USDC_MINT, seller, true);
  const holderAta = getAssociatedTokenAddressSync(USDC_MINT, holder.publicKey, true);
  // Ensure the seller + holder ATAs exist (rent paid by fee payer).
  const ataIxs = [
    createAssociatedTokenAccountIdempotentInstruction(feePayer.publicKey, sellerAta, seller, USDC_MINT),
    createAssociatedTokenAccountIdempotentInstruction(feePayer.publicKey, holderAta, holder.publicKey, USDC_MINT),
  ];
  await sendAndConfirm(conn, ataIxs, feePayer, []);

  const sellerBefore = (await usdcBalance(conn, seller)) ?? 0n;

  const payoutIxs = await buildInstantPayoutInstructions({
    connection: conn,
    swigAddress,
    claimPda,
    vaultPda,
    financier: holder.publicKey, // the holder collecting == financier (signs settle)
    dexterAuthority: master.publicKey,
    claimAmount: LOCK_AMOUNT_ATOMIC,
    financierSpread: 0n, // 100% to the seller
    sellerAta,
    financierAta: holderAta,
    feePayer: feePayer.publicKey,
  });
  // Signers for the payout: holder (settle holder), master (dexterAuthority), feePayer.
  receipts.txSignatures.settle = await sendAndConfirm(
    conn,
    [ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ...payoutIxs],
    feePayer,
    [holder, master],
  );
  log('settle tx      :', receipts.txSignatures.settle);

  // Assert: seller ATA rose by the claim amount; claim gone from Pending;
  // outstandingLockedAmount back to pre-lock.
  let sellerAfter = sellerBefore;
  for (let i = 0; i < 25 && sellerAfter < sellerBefore + LOCK_AMOUNT_ATOMIC; i++) {
    sellerAfter = (await usdcBalance(conn, seller)) ?? 0n;
    if (sellerAfter < sellerBefore + LOCK_AMOUNT_ATOMIC) await sleep(2000);
  }
  assert(sellerAfter - sellerBefore === LOCK_AMOUNT_ATOMIC, 'seller ATA rose by claim amount',
    `${sellerBefore} → ${sellerAfter}`);

  let stillPending = await fetchVaultLockedClaims(conn, vaultPda, { status: 'Pending' });
  for (let i = 0; i < 15 && stillPending.some((c) => c.address === claimPda.toBase58()); i++) {
    await sleep(2000);
    stillPending = await fetchVaultLockedClaims(conn, vaultPda, { status: 'Pending' });
  }
  assert(!stillPending.some((c) => c.address === claimPda.toBase58()), 'claim flipped to Settled (gone from Pending)');

  vaultFull = await readVaultFull(conn, vaultPda);
  const outstandingAfterSettle = BigInt(vaultFull.outstandingLockedAmount);
  assert(outstandingAfterSettle === outstandingPreLock, 'outstandingLockedAmount returned to pre-lock',
    `${outstandingAfterSettle} == ${outstandingPreLock}`);

  // ── DONE ───────────────────────────────────────────────────────────────────
  receipts.result = 'PASS';
  receipts.finishedAt = new Date().toISOString();
  receipts.assertions = assertions;
  console.log('\n===== STEP-4 LOCK-MODE PROOF RESULT =====');
  console.log('Full lock-mode lifecycle (create→activate→register→open→sign→lock→');
  console.log('reservation-guard→settle) proven SDK-direct on mainnet.\n');
  console.log(JSON.stringify(receipts, null, 2));
  process.exit(0);
}

main().catch((e) => {
  console.error(`\n[step4] FAILED at ${STEP}:`, e?.stack || e);
  receipts.result = `FAILED at ${STEP}`;
  receipts.error = String(e?.message ?? e);
  receipts.assertions = assertions;
  console.error('[step4] partial receipts:', JSON.stringify(receipts, null, 2));
  process.exit(1);
});
