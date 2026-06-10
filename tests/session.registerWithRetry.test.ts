import { describe, it, expect } from 'vitest';
import { Keypair, Connection, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { registerSessionWithRetry } from '../src/session/registerWithRetry.js';
import { deriveSessionPda } from '../src/session/derive.js';
import type { SessionAccountState } from '../src/types.js';

const VAULT = Keypair.generate().publicKey;
const SELLER = Keypair.generate().publicKey;
const SWIG = Keypair.generate().publicKey;
const ATA = Keypair.generate().publicKey;
const PAYER = Keypair.generate().publicKey;
const SESSION_KEY = Keypair.generate().publicKey.toBytes();
const FUTURE = BigInt(Math.floor(Date.now() / 1000) + 3600);

// the connection is never touched — both fetch seams are injected
const fakeConnection = {} as unknown as Connection;

function liveState(counterparty: PublicKey, sessionPubkey?: Uint8Array): SessionAccountState {
  const [pda] = deriveSessionPda(VAULT, counterparty);
  return {
    address: pda.toBase58(),
    version: 1,
    bump: 255,
    vault: VAULT.toBase58(),
    session: {
      sessionPubkey: sessionPubkey ?? Keypair.generate().publicKey.toBytes(),
      maxAmount: 1000n,
      expiresAt: Number(FUTURE),
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

function baseArgs(overrides: Record<string, unknown> = {}) {
  return {
    connection: fakeConnection,
    vaultPda: VAULT,
    sessionPubkey: SESSION_KEY,
    maxAmount: 500n,
    expiresAt: FUTURE,
    allowedCounterparty: SELLER,
    nonce: 1,
    maxRevolvingCapacity: 500n,
    swigAddress: SWIG,
    vaultUsdcAta: ATA,
    payer: PAYER,
    clientDataJSON: new Uint8Array([1]),
    authenticatorData: new Uint8Array([2]),
    fetchSession: async () => null,
    ...overrides,
  };
}

describe('registerSessionWithRetry', () => {
  it('happy path: one fetch, one send, replaced=false on absent session', async () => {
    let sends = 0;
    let fetches = 0;
    const result = await registerSessionWithRetry({
      ...baseArgs(),
      fetchSessions: async () => {
        fetches += 1;
        return [];
      },
      send: async (ixs: TransactionInstruction[]) => {
        sends += 1;
        expect(ixs.length).toBe(1); // just the register ix (no preInstructions passed)
        return 'sig-1';
      },
    } as any);
    expect(result).toEqual({ signature: 'sig-1', attempts: 1, replaced: false, siblingCount: 0 });
    expect(sends).toBe(1);
    expect(fetches).toBe(1);
  });

  it('prepends preInstructions and reports replaced=true for a live same-counterparty session', async () => {
    const pre = new TransactionInstruction({ keys: [], programId: Keypair.generate().publicKey, data: Buffer.from([9]) });
    const result = await registerSessionWithRetry({
      ...baseArgs(),
      fetchSession: async () => liveState(SELLER),
      fetchSessions: async () => [liveState(SELLER)], // target itself — excluded by the builder
      preInstructions: [pre],
      send: async (ixs: TransactionInstruction[]) => {
        expect(ixs[0].data.equals(Buffer.from([9]))).toBe(true);
        expect(ixs.length).toBe(2);
        return 'sig-2';
      },
    } as any);
    expect(result.replaced).toBe(true);
    expect(result.siblingCount).toBe(0); // target excluded from its own sibling set
  });

  it('retries on IncompleteSessionSet with a REFETCHED sibling set', async () => {
    const otherA = Keypair.generate().publicKey;
    const otherB = Keypair.generate().publicKey;
    let fetches = 0;
    let sends = 0;
    const result = await registerSessionWithRetry({
      ...baseArgs(),
      fetchSessions: async () => {
        fetches += 1;
        // first fetch: stale 2-sibling set; second: 1 sibling (one swept)
        return fetches === 1 ? [liveState(otherA), liveState(otherB)] : [liveState(otherA)];
      },
      send: async (ixs: TransactionInstruction[]) => {
        sends += 1;
        if (sends === 1) {
          throw new Error('Simulation failed: custom program error: 0x1786 IncompleteSessionSet');
        }
        // second attempt: 8 fixed accounts + 1 sibling
        expect(ixs[0].keys.length).toBe(9);
        return 'sig-3';
      },
    } as any);
    expect(result).toMatchObject({ signature: 'sig-3', attempts: 2, siblingCount: 1 });
    expect(fetches).toBe(2);
  });

  it('retries on SessionAccountsNotSorted by name', async () => {
    let sends = 0;
    const result = await registerSessionWithRetry({
      ...baseArgs(),
      fetchSessions: async () => [],
      send: async () => {
        sends += 1;
        if (sends === 1) throw new Error('SessionAccountsNotSorted');
        return 'sig-4';
      },
    } as any);
    expect(result.attempts).toBe(2);
  });

  it('gives up after maxAttempts and rethrows', async () => {
    let sends = 0;
    await expect(
      registerSessionWithRetry({
        ...baseArgs(),
        maxAttempts: 2,
        fetchSessions: async () => [],
        send: async () => {
          sends += 1;
          throw new Error('custom program error: 0x1786');
        },
      } as any),
    ).rejects.toThrow('0x1786');
    expect(sends).toBe(2);
  });

  it('does NOT retry non-session-set errors', async () => {
    let sends = 0;
    await expect(
      registerSessionWithRetry({
        ...baseArgs(),
        fetchSessions: async () => [],
        send: async () => {
          sends += 1;
          throw new Error('custom program error: 0x1772 SessionWouldOvercommitVault');
        },
      } as any),
    ).rejects.toThrow('SessionWouldOvercommitVault');
    expect(sends).toBe(1);
  });
});
