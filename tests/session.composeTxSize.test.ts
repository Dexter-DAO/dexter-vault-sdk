/**
 * TX-SIZE MEASUREMENT — the K-T4a legacy-vs-v0 go/no-go (load-bearing).
 *
 * The composed atomic revoke-then-register is FIVE instructions in production
 * shape (dexter-api sponsorSend: [CB, secp(revoke), revokeIx, secp(register),
 * registerIx]), one signer (the sponsor fee payer). Legacy Transaction wire
 * cap = 1232 bytes (IPv6 MTU 1280 − 48). This test builds the EXACT composed
 * instruction list with production-realistic ceremony bytes
 * (clientDataJSON ≈ 134 B, authenticatorData = 37 B — the same shape the
 * browser and the dexter-vault test harness produce) at 0 / 1 / 4 live
 * siblings and serializes:
 *   - the legacy Transaction (what sponsorSend builds today),
 *   - the v0 VersionedTransaction with NO lookup table,
 *   - the v0 VersionedTransaction with an ALT covering the vault's static
 *     accounts (what a sponsor can actually deploy).
 *
 * The numbers these assertions pin (measured 2026-07-06, @solana/web3.js 1.98):
 *
 *   siblings | legacy | v0 no-ALT | v0+ALT(statics) | v0+ALT(statics+siblings)
 *   ---------+--------+-----------+-----------------+-------------------------
 *       0    |  1347  |   1349    |      1166       |          1166
 *       1    |  1380  |   1382    |      1199       |          1168
 *       4    |  1479  |   1481    |      1298       |          1174
 *
 *   register-only baseline (no revoke pair; CB + secp + register): 937 legacy.
 *
 * VERDICT: the composed 5-ix tx NEVER fits legacy — 1347 > 1232 at ZERO
 * siblings (web3.js Transaction.serialize itself throws "Transaction too
 * large: 1347 > 1232") — and v0 alone saves nothing (it only helps via
 * lookup tables). The composed path REQUIRES a v0 VersionedTransaction with
 * an address lookup table:
 *   - ALT holding the vault's static commons (vault, target session PDA,
 *     vaultUsdcAta, swig, swigWalletAddress, sysvar + system):
 *     fits at 0-1 siblings (1166/1199); 2 siblings = 1232 — EXACTLY at the
 *     cap, zero margin; ≥3 overflows. Threshold: 1 sibling.
 *   - ALT additionally holding the sibling session PDAs (the sponsor knows
 *     them — fetchVaultSessionAccounts — and extends the ALT before
 *     composing; 1-slot warmup): each ALT-resident sibling costs 2 B
 *     (1 ix-index + 1 lookup-index) instead of 33 B → 1174 at 4 siblings,
 *     headroom for ~25 more. This is the production shape for K-T4b. A
 *     sibling that appears between ALT-extend and compose rides as a static
 *     key (+33 B) — still fine below ~2 unlisted siblings.
 */
import { describe, it, expect } from 'vitest';
import {
  ComputeBudgetProgram,
  Keypair,
  MessageV0,
  PublicKey,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
  AddressLookupTableAccount,
} from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha256';
import { buildRegisterSessionKeyInstruction } from '../src/instructions/registerSession.js';
import { buildRevokeSessionKeyInstruction } from '../src/instructions/revokeSession.js';
import { buildSecp256r1VerifyInstruction } from '../src/precompile/secp256r1.js';
import { sessionRegisterMessage, sessionRevokeMessage } from '../src/messages/session.js';
import { deriveSessionPda } from '../src/session/derive.js';
import { deriveSwigWalletAddress } from '../src/instructions/withdraw.js';
import {
  DEXTER_VAULT_PROGRAM_ID,
  SECP256R1_PROGRAM_ID,
  INSTRUCTIONS_SYSVAR_ID,
} from '../src/constants/index.js';
import {
  generateTestPasskey,
  signOperationFixture,
  type SignedCeremonyFixture,
} from './helpers/webauthnFixture.js';
import { SystemProgram } from '@solana/web3.js';

/** Legacy wire cap: 1280 (IPv6 MTU) − 40 (IPv6 hdr) − 8 (fragment hdr). */
const PACKET_DATA_SIZE = 1232;

const PASSKEY = generateTestPasskey();
const PAYER = Keypair.generate();
const VAULT = Keypair.generate().publicKey;
const SELLER = Keypair.generate().publicKey;
const SWIG = Keypair.generate().publicKey;
const ATA = Keypair.generate().publicKey;
const NEW_SESSION_KEY = Keypair.generate().publicKey.toBytes();
const OLD_SESSION_KEY = Keypair.generate().publicKey.toBytes();
const EXPIRES = 4_000_000_000n;
const BLOCKHASH = Keypair.generate().publicKey.toBase58(); // 32 bytes, shape-correct

function precompileMessageOf(c: SignedCeremonyFixture): Uint8Array {
  const out = new Uint8Array(c.authenticatorData.length + 32);
  out.set(c.authenticatorData, 0);
  out.set(sha256(c.clientDataJSON), c.authenticatorData.length);
  return out;
}

/** The production-shaped composed instruction list at `siblingCount` OTHER
 *  live siblings. `withRevoke=false` gives the register-only baseline. */
function composedInstructions(
  siblingCount: number,
  withRevoke: boolean,
): { ixs: TransactionInstruction[]; siblings: PublicKey[] } {
  const registerCeremony = signOperationFixture(
    PASSKEY,
    sessionRegisterMessage({
      programId: DEXTER_VAULT_PROGRAM_ID,
      vaultPda: VAULT,
      sessionPubkey: NEW_SESSION_KEY,
      maxAmount: 10_000n,
      expiresAt: EXPIRES,
      allowedCounterparty: SELLER,
      nonce: 2,
      maxRevolvingCapacity: 10_000n,
    }),
  );
  const siblings = Array.from({ length: siblingCount }, () =>
    deriveSessionPda(VAULT, Keypair.generate().publicKey)[0],
  );
  const registerIx = buildRegisterSessionKeyInstruction({
    vaultPda: VAULT,
    sessionPubkey: NEW_SESSION_KEY,
    maxAmount: 10_000n,
    expiresAt: EXPIRES,
    allowedCounterparty: SELLER,
    nonce: 2,
    maxRevolvingCapacity: 10_000n,
    swigAddress: SWIG,
    vaultUsdcAta: ATA,
    payer: PAYER.publicKey,
    siblingSessionPdas: siblings,
    clientDataJSON: registerCeremony.clientDataJSON,
    authenticatorData: registerCeremony.authenticatorData,
  });
  const secpRegister = buildSecp256r1VerifyInstruction(
    PASSKEY.publicKey,
    registerCeremony.signature,
    precompileMessageOf(registerCeremony),
  );
  const cb = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });

  if (!withRevoke) return { ixs: [cb, secpRegister, registerIx], siblings };

  const revokeCeremony = signOperationFixture(
    PASSKEY,
    sessionRevokeMessage({
      programId: DEXTER_VAULT_PROGRAM_ID,
      vaultPda: VAULT,
      sessionPubkey: OLD_SESSION_KEY,
    }),
  );
  const secpRevoke = buildSecp256r1VerifyInstruction(
    PASSKEY.publicKey,
    revokeCeremony.signature,
    precompileMessageOf(revokeCeremony),
  );
  const revokeIx = buildRevokeSessionKeyInstruction({
    vaultPda: VAULT,
    allowedCounterparty: SELLER,
    clientDataJSON: revokeCeremony.clientDataJSON,
    authenticatorData: revokeCeremony.authenticatorData,
  });
  return { ixs: [cb, secpRevoke, revokeIx, secpRegister, registerIx], siblings };
}

/** Exact wire size of the legacy tx (1 signer, like sponsorSend), computed
 *  from the compiled message so an OVERSIZED tx is still measurable —
 *  Transaction.serialize() itself throws "Transaction too large" past 1232,
 *  which is the very overflow this test quantifies. Wire layout:
 *  compact-u16 sig count (1 B at 1 sig) + 64 B/sig + message bytes. */
function legacySize(instructions: TransactionInstruction[]): number {
  const tx = new Transaction().add(...instructions);
  tx.feePayer = PAYER.publicKey;
  tx.recentBlockhash = BLOCKHASH;
  const msg = tx.compileMessage();
  return 1 + msg.header.numRequiredSignatures * 64 + msg.serialize().length;
}

/** Compact-u16 encoded length in bytes. */
function compactLen(n: number): number {
  return n < 0x80 ? 1 : n < 0x4000 ? 2 : 3;
}

/** Exact v0 wire size, computed analytically — MessageV0.serialize() encodes
 *  into a FIXED 1232-byte buffer ("encoding overruns Uint8Array" past the
 *  cap), and quantifying that overflow is the point. Cross-checked against
 *  the real serializer whenever the message fits. */
function v0Size(
  instructions: TransactionInstruction[],
  lookupTables: AddressLookupTableAccount[] = [],
): number {
  const msg = MessageV0.compile({
    payerKey: PAYER.publicKey,
    instructions,
    recentBlockhash: BLOCKHASH,
    addressLookupTableAccounts: lookupTables,
  });
  let m = 1; // version prefix (0x80)
  m += 3; // header
  m += compactLen(msg.staticAccountKeys.length) + 32 * msg.staticAccountKeys.length;
  m += 32; // recent blockhash
  m += compactLen(msg.compiledInstructions.length);
  for (const ix of msg.compiledInstructions) {
    m += 1; // programIdIndex
    m += compactLen(ix.accountKeyIndexes.length) + ix.accountKeyIndexes.length;
    m += compactLen(ix.data.length) + ix.data.length;
  }
  m += compactLen(msg.addressTableLookups.length);
  for (const l of msg.addressTableLookups) {
    m += 32; // table account key
    m += compactLen(l.writableIndexes.length) + l.writableIndexes.length;
    m += compactLen(l.readonlyIndexes.length) + l.readonlyIndexes.length;
  }
  const wire = 1 + msg.header.numRequiredSignatures * 64 + m;
  if (wire <= PACKET_DATA_SIZE) {
    // the analytic math must agree with the real serializer byte-for-byte
    expect(m).toBe(msg.serialize().length);
  }
  return wire;
}

/** An ALT a sponsor can realistically maintain: the vault's static account
 *  set (per-vault PDAs + the fixed program/sysvar ids), optionally extended
 *  with the sibling session PDAs (the production K-T4b shape). The fee payer
 *  cannot be ALT-resident (it must stay a static signer), and program ids
 *  INVOKED by instructions stay static in web3.js compile — measured here as
 *  data, not assumed. */
function sponsorAlt(siblings: PublicKey[]): AddressLookupTableAccount {
  const [sessionPda] = deriveSessionPda(VAULT, SELLER);
  return new AddressLookupTableAccount({
    key: Keypair.generate().publicKey,
    state: {
      deactivationSlot: BigInt('0xffffffffffffffff'),
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      addresses: [
        VAULT,
        sessionPda,
        ATA,
        SWIG,
        deriveSwigWalletAddress(SWIG),
        INSTRUCTIONS_SYSVAR_ID,
        SystemProgram.programId,
        // program ids (DEXTER_VAULT_PROGRAM_ID, SECP256R1, ComputeBudget) are
        // listed for completeness; invoked program ids remain static keys.
        DEXTER_VAULT_PROGRAM_ID,
        SECP256R1_PROGRAM_ID,
        ...siblings,
      ],
    },
  });
}

describe('composed revoke-then-register tx size (K-T4a deliverable 2)', () => {
  const cases = [0, 1, 4] as const;
  const measured: Record<string, Record<number, number>> = {
    legacy: {},
    v0: {},
    v0AltStatics: {},
    v0AltFull: {},
  };

  for (const n of cases) {
    it(`measures the composed tx at ${n} sibling(s)`, () => {
      const { ixs, siblings } = composedInstructions(n, true);
      measured.legacy[n] = legacySize(ixs);
      measured.v0[n] = v0Size(ixs);
      measured.v0AltStatics[n] = v0Size(ixs, [sponsorAlt([])]);
      measured.v0AltFull[n] = v0Size(ixs, [sponsorAlt(siblings)]);
      // the load-bearing numbers, reported (run with --disable-console-intercept)
      console.log(
        `[tx-size] siblings=${n} legacy=${measured.legacy[n]}B ` +
          `v0=${measured.v0[n]}B v0+ALT(statics)=${measured.v0AltStatics[n]}B ` +
          `v0+ALT(statics+siblings)=${measured.v0AltFull[n]}B (cap ${PACKET_DATA_SIZE}B)`,
      );
      expect(measured.legacy[n]).toBeGreaterThan(0);
    });
  }

  it('register-only baseline (no revoke pair) fits legacy comfortably', () => {
    const size = legacySize(composedInstructions(0, false).ixs);
    console.log(`[tx-size] register-only siblings=0 legacy=${size}B`);
    expect(size).toBeLessThanOrEqual(PACKET_DATA_SIZE);
  });

  it('VERDICT: composed legacy OVERFLOWS at zero siblings — the compose path requires v0 + ALT', () => {
    // Load-bearing go/no-go: if this ever starts fitting legacy (e.g. smaller
    // ceremonies), revisit the v0 requirement documented in
    // composeRevokeThenRegister.ts. Until then: legacy is a hard NO.
    expect(measured.legacy[0]).toBeGreaterThan(PACKET_DATA_SIZE);
    // v0 without a lookup table saves nothing (it only relocates bytes).
    expect(measured.v0[0]).toBeGreaterThan(PACKET_DATA_SIZE);
    // v0 + statics-only ALT: fits at 0-1 siblings, NOT at 4 — the threshold
    // the K-T4b sponsor must respect if it does not ALT the sibling PDAs.
    expect(measured.v0AltStatics[0]).toBeLessThanOrEqual(PACKET_DATA_SIZE);
    expect(measured.v0AltStatics[1]).toBeLessThanOrEqual(PACKET_DATA_SIZE);
    expect(measured.v0AltStatics[4]).toBeGreaterThan(PACKET_DATA_SIZE);
    // v0 + ALT with sibling PDAs resident: the production shape — fits at 4
    // siblings with real margin (each ALT-resident sibling costs 1 B).
    expect(measured.v0AltFull[4]).toBeLessThanOrEqual(PACKET_DATA_SIZE);
    // Marginal sibling cost when siblings stay static: 33 B (32 key + 1 index).
    expect(measured.legacy[1] - measured.legacy[0]).toBe(33);
    expect((measured.legacy[4] - measured.legacy[1]) / 3).toBe(33);
  });
});
