/**
 * composeRevokeThenRegister — the K-T4a atomic single-tx revoke-then-register
 * over ONE session PDA.
 *
 * Contract under test (plan 2026-07-06-kt4-revoke-then-register.md, K-T4a):
 *  - NOT live (absent / cleared / expired) → register-only:
 *      send receives [ ...callerPre, secpRegister, registerIx ], revoked=false.
 *  - LIVE → atomic compose:
 *      send receives [ ...callerPre, secpRevoke, revokeIx, secpRegister,
 *      registerIx ] — BOTH precompile adjacencies preserved (each vault ix
 *      reads the secp sibling at current_index − 1).
 *  - LIVE + no revokeCeremony → RevokeCeremonyRequiredError (the caller's 409).
 *  - revokeCeremony challenge not bound to the CURRENT live session pubkey
 *    (rotation race) → RevokeCeremonyMismatchError before any send.
 *  - The composed block rides registerSessionWithRetry's preInstructions seam,
 *    so it is re-prepended VERBATIM on every retry attempt (safe: the tx is
 *    atomic — a failed attempt means the in-tx revoke never landed either).
 *
 * Assertions run against REAL builder outputs (byte-level secp offsets,
 * discriminators, PDA keys) with realistic WebAuthn ceremonies — no mock
 * instruction shapes.
 */
import { describe, it, expect } from 'vitest';
import { Keypair, Connection, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha256';
import {
  composeRevokeThenRegister,
  RevokeCeremonyRequiredError,
  RevokeCeremonyMismatchError,
} from '../src/session/composeRevokeThenRegister.js';
import { deriveSessionPda } from '../src/session/derive.js';
import { sessionRegisterMessage, sessionRevokeMessage } from '../src/messages/session.js';
import {
  DEXTER_VAULT_PROGRAM_ID,
  SECP256R1_PROGRAM_ID,
  DISCRIMINATORS,
} from '../src/constants/index.js';
import {
  generateTestPasskey,
  signOperationFixture,
  type SignedCeremonyFixture,
} from './helpers/webauthnFixture.js';
import type { SessionAccountState } from '../src/types.js';

const VAULT = Keypair.generate().publicKey;
const SELLER = Keypair.generate().publicKey;
const SWIG = Keypair.generate().publicKey;
const ATA = Keypair.generate().publicKey;
const PAYER = Keypair.generate().publicKey;
const NEW_SESSION_KEY = Keypair.generate().publicKey.toBytes();
const OLD_SESSION_KEY = Keypair.generate().publicKey.toBytes();
const FUTURE = BigInt(Math.floor(Date.now() / 1000) + 3600);
const PASSKEY = generateTestPasskey();

// the connection is never touched — both fetch seams are injected
const fakeConnection = {} as unknown as Connection;

// secp256r1 ix data layout (precompile.ts): header(2) + offsets(14) + sig(64)
// + pubkey(33) + message. Slice points for byte-level assertions.
const SECP_PUBKEY_OFFSET = 2 + 14 + 64;
const SECP_MESSAGE_OFFSET = SECP_PUBKEY_OFFSET + 33;

function precompileMessageOf(c: SignedCeremonyFixture): Uint8Array {
  const out = new Uint8Array(c.authenticatorData.length + 32);
  out.set(c.authenticatorData, 0);
  out.set(sha256(c.clientDataJSON), c.authenticatorData.length);
  return out;
}

function expectSecpIx(ix: TransactionInstruction, ceremony: SignedCeremonyFixture): void {
  expect(ix.programId.equals(SECP256R1_PROGRAM_ID)).toBe(true);
  expect(ix.keys.length).toBe(0);
  const data = new Uint8Array(ix.data);
  expect(data.slice(SECP_PUBKEY_OFFSET, SECP_MESSAGE_OFFSET)).toEqual(PASSKEY.publicKey);
  expect(data.slice(SECP_MESSAGE_OFFSET)).toEqual(precompileMessageOf(ceremony));
}

function liveState(opts: {
  counterparty?: PublicKey;
  sessionPubkey?: Uint8Array;
  version?: number;
  expiresAt?: number;
} = {}): SessionAccountState {
  const counterparty = opts.counterparty ?? SELLER;
  const [pda] = deriveSessionPda(VAULT, counterparty);
  return {
    address: pda.toBase58(),
    version: opts.version ?? 1,
    bump: 255,
    vault: VAULT.toBase58(),
    session: {
      sessionPubkey: opts.sessionPubkey ?? OLD_SESSION_KEY,
      maxAmount: 1000n,
      expiresAt: opts.expiresAt ?? Number(FUTURE),
      allowedCounterparty: counterparty.toBase58(),
      nonce: 1,
      spent: 0n,
      currentOutstanding: 0n,
      maxRevolvingCapacity: 1000n,
      crystallizedCumulative: 0n,
      lastLockedSequence: 0,
    },
  };
}

const REGISTER_ARGS = {
  sessionPubkey: NEW_SESSION_KEY,
  maxAmount: 500n,
  expiresAt: FUTURE,
  nonce: 2,
  maxRevolvingCapacity: 500n,
  swigAddress: SWIG,
  vaultUsdcAta: ATA,
  payer: PAYER,
};

// Ceremonies signed over the REAL operation messages (challenge binding intact).
const registerCeremony = signOperationFixture(
  PASSKEY,
  sessionRegisterMessage({
    programId: DEXTER_VAULT_PROGRAM_ID,
    vaultPda: VAULT,
    sessionPubkey: NEW_SESSION_KEY,
    maxAmount: REGISTER_ARGS.maxAmount,
    expiresAt: REGISTER_ARGS.expiresAt,
    allowedCounterparty: SELLER,
    nonce: REGISTER_ARGS.nonce,
    maxRevolvingCapacity: REGISTER_ARGS.maxRevolvingCapacity,
  }),
);
const revokeCeremony = signOperationFixture(
  PASSKEY,
  sessionRevokeMessage({
    programId: DEXTER_VAULT_PROGRAM_ID,
    vaultPda: VAULT,
    sessionPubkey: OLD_SESSION_KEY,
  }),
);

function baseArgs(overrides: Record<string, unknown> = {}) {
  return {
    connection: fakeConnection,
    vaultPda: VAULT,
    allowedCounterparty: SELLER,
    registerArgs: REGISTER_ARGS,
    registerCeremony,
    credentialPublicKey: PASSKEY.publicKey,
    fetchSession: async () => null,
    fetchSessions: async () => [],
    ...overrides,
  };
}

describe('composeRevokeThenRegister', () => {
  it('register-only when no session account exists: [secpRegister, registerIx], revoked=false', async () => {
    let sent: TransactionInstruction[] = [];
    const result = await composeRevokeThenRegister({
      ...baseArgs(),
      send: async (ixs: TransactionInstruction[]) => {
        sent = ixs;
        return 'sig-1';
      },
    } as any);
    expect(result).toMatchObject({ signature: 'sig-1', revoked: false, replaced: false });
    expect(sent.length).toBe(2);
    expectSecpIx(sent[0], registerCeremony);
    expect(sent[1].programId.equals(DEXTER_VAULT_PROGRAM_ID)).toBe(true);
    expect(new Uint8Array(sent[1].data.subarray(0, 8))).toEqual(
      DISCRIMINATORS.register_session_key,
    );
  });

  it('register-only when the account is cleared (version 0)', async () => {
    let sent: TransactionInstruction[] = [];
    const result = await composeRevokeThenRegister({
      ...baseArgs(),
      fetchSession: async () => liveState({ version: 0 }),
      send: async (ixs: TransactionInstruction[]) => {
        sent = ixs;
        return 'sig-2';
      },
    } as any);
    expect(result.revoked).toBe(false);
    expect(sent.length).toBe(2);
  });

  it('register-only when the session is expired (version 1, past expiry)', async () => {
    let sent: TransactionInstruction[] = [];
    const result = await composeRevokeThenRegister({
      ...baseArgs(),
      fetchSession: async () => liveState({ expiresAt: 1 }),
      send: async (ixs: TransactionInstruction[]) => {
        sent = ixs;
        return 'sig-3';
      },
    } as any);
    expect(result.revoked).toBe(false);
    expect(sent.length).toBe(2);
    // no revoke instruction anywhere in the register-only compose
    for (const ix of sent) {
      if (ix.programId.equals(DEXTER_VAULT_PROGRAM_ID)) {
        expect(new Uint8Array(ix.data.subarray(0, 8))).not.toEqual(
          DISCRIMINATORS.revoke_session_key,
        );
      }
    }
  });

  it('LIVE session: composes [secpRevoke, revokeIx, secpRegister, registerIx] with both adjacencies', async () => {
    let sent: TransactionInstruction[] = [];
    const result = await composeRevokeThenRegister({
      ...baseArgs(),
      fetchSession: async () => liveState(),
      // the register-time sibling fetch sees the (still-live-at-fetch) target
      // itself — the builder must exclude it from its own sibling set
      fetchSessions: async () => [liveState()],
      revokeCeremony,
      send: async (ixs: TransactionInstruction[]) => {
        sent = ixs;
        return 'sig-4';
      },
    } as any);
    expect(result).toMatchObject({ signature: 'sig-4', revoked: true, replaced: true });

    expect(sent.length).toBe(4);
    // [0] secp over the REVOKE ceremony, immediately before the revoke ix
    expectSecpIx(sent[0], revokeCeremony);
    // [1] revoke_session_key on the target PDA
    const revokeIx = sent[1];
    expect(revokeIx.programId.equals(DEXTER_VAULT_PROGRAM_ID)).toBe(true);
    expect(new Uint8Array(revokeIx.data.subarray(0, 8))).toEqual(
      DISCRIMINATORS.revoke_session_key,
    );
    expect(new Uint8Array(revokeIx.data.subarray(8, 40))).toEqual(SELLER.toBytes());
    const [sessionPda] = deriveSessionPda(VAULT, SELLER);
    expect(revokeIx.keys[0].pubkey.equals(VAULT)).toBe(true);
    expect(revokeIx.keys[1].pubkey.equals(sessionPda)).toBe(true);
    // [2] secp over the REGISTER ceremony, immediately before the register ix
    expectSecpIx(sent[2], registerCeremony);
    // [3] register_session_key; target excluded from its own sibling set
    const registerIx = sent[3];
    expect(new Uint8Array(registerIx.data.subarray(0, 8))).toEqual(
      DISCRIMINATORS.register_session_key,
    );
    expect(registerIx.keys.length).toBe(8); // 8 fixed accounts, zero siblings
  });

  it('passes the OTHER live siblings through to the register ix', async () => {
    const other = liveState({ counterparty: Keypair.generate().publicKey });
    let sent: TransactionInstruction[] = [];
    await composeRevokeThenRegister({
      ...baseArgs(),
      fetchSession: async () => liveState(),
      fetchSessions: async () => [liveState(), other],
      revokeCeremony,
      send: async (ixs: TransactionInstruction[]) => {
        sent = ixs;
        return 'sig-5';
      },
    } as any);
    const registerIx = sent[3];
    expect(registerIx.keys.length).toBe(9); // 8 fixed + 1 OTHER sibling
    expect(registerIx.keys[8].pubkey.toBase58()).toBe(other.address);
  });

  it('keeps caller preInstructions FIRST (compute budget ahead of the composed block)', async () => {
    const cb = new TransactionInstruction({
      keys: [],
      programId: Keypair.generate().publicKey,
      data: Buffer.from([9]),
    });
    let sent: TransactionInstruction[] = [];
    await composeRevokeThenRegister({
      ...baseArgs(),
      fetchSession: async () => liveState(),
      revokeCeremony,
      preInstructions: [cb],
      send: async (ixs: TransactionInstruction[]) => {
        sent = ixs;
        return 'sig-6';
      },
    } as any);
    expect(sent.length).toBe(5);
    expect(sent[0].data.equals(Buffer.from([9]))).toBe(true);
    expectSecpIx(sent[1], revokeCeremony);
    expectSecpIx(sent[3], registerCeremony);
  });

  it('LIVE session without a revokeCeremony throws RevokeCeremonyRequiredError before any send', async () => {
    let sends = 0;
    await expect(
      composeRevokeThenRegister({
        ...baseArgs(),
        fetchSession: async () => liveState(),
        send: async () => {
          sends += 1;
          return 'never';
        },
      } as any),
    ).rejects.toThrow(RevokeCeremonyRequiredError);
    expect(sends).toBe(0);
  });

  it('revoke ceremony bound to a STALE session pubkey throws RevokeCeremonyMismatchError (rotation race)', async () => {
    // ceremony signed over OLD_SESSION_KEY, but the CURRENT live session rotated
    const rotated = Keypair.generate().publicKey.toBytes();
    let sends = 0;
    await expect(
      composeRevokeThenRegister({
        ...baseArgs(),
        fetchSession: async () => liveState({ sessionPubkey: rotated }),
        revokeCeremony,
        send: async () => {
          sends += 1;
          return 'never';
        },
      } as any),
    ).rejects.toThrow(RevokeCeremonyMismatchError);
    expect(sends).toBe(0);
  });

  it('retry: the composed revoke pair rides EVERY attempt (atomicity makes the re-send safe)', async () => {
    let sends = 0;
    const result = await composeRevokeThenRegister({
      ...baseArgs(),
      fetchSession: async () => liveState(),
      fetchSessions: async () => [liveState()],
      revokeCeremony,
      send: async (ixs: TransactionInstruction[]) => {
        sends += 1;
        expect(ixs.length).toBe(4);
        expectSecpIx(ixs[0], revokeCeremony);
        expect(new Uint8Array(ixs[1].data.subarray(0, 8))).toEqual(
          DISCRIMINATORS.revoke_session_key,
        );
        if (sends === 1) {
          throw new Error('Simulation failed: custom program error: 0x1786 IncompleteSessionSet');
        }
        return 'sig-7';
      },
    } as any);
    expect(result).toMatchObject({ signature: 'sig-7', revoked: true, attempts: 2 });
    expect(sends).toBe(2);
  });
});
