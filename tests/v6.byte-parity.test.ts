import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import {
  DISCRIMINATORS,
  INSTRUCTIONS_SYSVAR_ID,
  SESSION_ACCOUNT_DISCRIMINATOR,
  SESSION_ACCOUNT_SIZE,
} from '../src/constants/index.js';
import { buildRegisterSessionKeyInstruction } from '../src/instructions/index.js';
import { deriveSwigWalletAddress } from '../src/instructions/withdraw.js';
import { deriveSessionPda, buildSiblingAccountMetas } from '../src/session/index.js';

const idl = JSON.parse(
  readFileSync(new URL('../src/idl/dexter_vault.json', import.meta.url), 'utf8'),
);

function idlDisc(name: string): number[] {
  const ix = idl.instructions.find((i: { name: string }) => i.name === name);
  if (!ix) throw new Error(`instruction ${name} not in IDL`);
  return ix.discriminator;
}

function idlAccount(name: string): { name: string; discriminator: number[] } {
  const acct = idl.accounts.find((a: { name: string }) => a.name === name);
  if (!acct) throw new Error(`account ${name} not in IDL`);
  return acct;
}

// ── IDL-derived account size walker ──────────────────────────────────────
// Sums field sizes straight from the IDL type tree so SESSION_ACCOUNT_SIZE
// cannot silently drift from the on-chain layout. Any field type the walker
// doesn't recognize (Option, Vec, String, enum, ...) throws loudly — a V7
// that adds one MUST fail this test, never skip the field.

class UnknownIdlTypeError extends Error {
  constructor(detail: string) {
    super(
      `unrecognized IDL field type ${detail} — extend the size walker in ` +
        'tests/v6.byte-parity.test.ts before trusting SESSION_ACCOUNT_SIZE',
    );
    this.name = 'UnknownIdlTypeError';
  }
}

const PRIMITIVE_SIZES: Record<string, number> = {
  u8: 1,
  u32: 4,
  u64: 8,
  i64: 8,
  pubkey: 32,
};

type IdlFieldType =
  | string
  | { array: [IdlFieldType, number] }
  | { defined: { name: string } };

function fieldTypeSize(ty: IdlFieldType): number {
  if (typeof ty === 'string') {
    const size = PRIMITIVE_SIZES[ty];
    if (size === undefined) throw new UnknownIdlTypeError(JSON.stringify(ty));
    return size;
  }
  if (ty !== null && typeof ty === 'object') {
    if ('array' in ty) {
      const [elem, len] = ty.array;
      if (typeof len !== 'number') throw new UnknownIdlTypeError(JSON.stringify(ty));
      return fieldTypeSize(elem) * len;
    }
    if ('defined' in ty) {
      return idlStructSize(ty.defined.name);
    }
  }
  throw new UnknownIdlTypeError(JSON.stringify(ty));
}

function idlStructSize(name: string): number {
  const entry = idl.types.find((t: { name: string }) => t.name === name);
  if (!entry) throw new Error(`type ${name} not in IDL types`);
  if (entry.type.kind !== 'struct') {
    throw new UnknownIdlTypeError(`${name} (kind=${entry.type.kind})`);
  }
  return entry.type.fields.reduce(
    (sum: number, field: { type: IdlFieldType }) => sum + fieldTypeSize(field.type),
    0,
  );
}

describe('discriminators match the V6 IDL', () => {
  test('every DISCRIMINATORS entry equals the IDL value', () => {
    for (const [name, bytes] of Object.entries(DISCRIMINATORS)) {
      expect(Array.from(bytes), name).toEqual(idlDisc(name));
    }
  });

  test('migration discriminators present', () => {
    expect(Array.from(DISCRIMINATORS.migrate_v5_to_v6)).toEqual([25, 38, 151, 206, 59, 103, 141, 175]);
    expect(Array.from(DISCRIMINATORS.migrate_v5_to_v6_with_session)).toEqual([225, 119, 165, 163, 251, 174, 42, 15]);
  });

  test('SessionAccount account discriminator matches IDL', () => {
    const acct = idlAccount('SessionAccount');
    expect(Array.from(SESSION_ACCOUNT_DISCRIMINATOR)).toEqual(acct.discriminator);
  });

  test('SESSION_ACCOUNT_SIZE equals the IDL-derived SessionAccount byte size', () => {
    idlAccount('SessionAccount'); // the account must exist in the IDL
    const derived = 8 + idlStructSize('SessionAccount'); // Anchor discriminator + struct
    expect(derived).toBe(SESSION_ACCOUNT_SIZE);
  });
});

describe('buildRegisterSessionKeyInstruction (V6)', () => {
  const vaultPda = PublicKey.unique();
  const swigAddress = PublicKey.unique();
  const vaultUsdcAta = PublicKey.unique();
  const payer = PublicKey.unique();
  const counterparty = PublicKey.unique();
  const siblings = [PublicKey.unique(), PublicKey.unique()];

  const ix = buildRegisterSessionKeyInstruction({
    vaultPda,
    sessionPubkey: new Uint8Array(32).fill(1),
    maxAmount: 1_000_000n,
    expiresAt: 4_000_000_000n,
    allowedCounterparty: counterparty,
    nonce: 7,
    maxRevolvingCapacity: 500_000n,
    swigAddress,
    vaultUsdcAta,
    payer,
    siblingSessionPdas: siblings,
    clientDataJSON: new Uint8Array([1, 2]),
    authenticatorData: new Uint8Array(37),
  });

  test('has the 8 fixed accounts in program order, then sorted writable siblings', () => {
    const [sessionPda] = deriveSessionPda(vaultPda, counterparty);
    const expectedSiblings = buildSiblingAccountMetas(siblings, sessionPda);
    expect(ix.keys.length).toBe(8 + expectedSiblings.length);
    expect(ix.keys[0]).toEqual({ pubkey: vaultPda, isSigner: false, isWritable: true });
    expect(ix.keys[1]).toEqual({ pubkey: vaultUsdcAta, isSigner: false, isWritable: false });
    expect(ix.keys[2].pubkey.equals(swigAddress)).toBe(true);
    expect(ix.keys[2].isWritable).toBe(false);
    expect(ix.keys[3].isWritable).toBe(false);
    expect(ix.keys[4].pubkey.equals(INSTRUCTIONS_SYSVAR_ID)).toBe(true);
    expect(ix.keys[5]).toEqual({ pubkey: sessionPda, isSigner: false, isWritable: true });
    expect(ix.keys[6]).toEqual({ pubkey: payer, isSigner: true, isWritable: true });
    expect(ix.keys[7].pubkey.equals(SystemProgram.programId)).toBe(true);
    for (let i = 0; i < expectedSiblings.length; i++) {
      expect(ix.keys[8 + i]).toEqual(expectedSiblings[i]);
    }
  });

  test('data layout unchanged from V5 (args did not change)', () => {
    expect(ix.data.length).toBe(8 + 32 + 8 + 8 + 32 + 4 + 8 + (4 + 2) + (4 + 37));
  });

  test('data bytes pinned end-to-end (V5-compat encoding regression)', () => {
    // Build the expected byte array by hand: disc + each Borsh field LE.
    const expected = new Uint8Array(8 + 32 + 8 + 8 + 32 + 4 + 8 + (4 + 2) + (4 + 37));
    const view = new DataView(expected.buffer);
    let o = 0;
    expected.set(DISCRIMINATORS.register_session_key, o); o += 8;
    expected.set(new Uint8Array(32).fill(1), o); o += 32;          // session_pubkey
    view.setBigUint64(o, 1_000_000n, true); o += 8;                // max_amount u64 LE
    view.setBigInt64(o, 4_000_000_000n, true); o += 8;             // expires_at i64 LE
    expected.set(counterparty.toBytes(), o); o += 32;              // allowed_counterparty
    view.setUint32(o, 7, true); o += 4;                            // nonce u32 LE
    view.setBigUint64(o, 500_000n, true); o += 8;                  // max_revolving_capacity u64 LE
    view.setUint32(o, 2, true); o += 4;                            // vec len(client_data_json)
    expected.set(new Uint8Array([1, 2]), o); o += 2;               // client_data_json bytes
    view.setUint32(o, 37, true); o += 4;                           // vec len(authenticator_data)
    o += 37;                                                       // authenticator_data (zeros)
    expect(o).toBe(expected.length);
    expect(new Uint8Array(ix.data)).toEqual(expected);
  });

  test('keys[3] is the derived swig_wallet_address', () => {
    expect(ix.keys[3].pubkey.equals(deriveSwigWalletAddress(swigAddress))).toBe(true);
  });

  test('empty sibling list (first-ever register) → exactly 8 accounts', () => {
    const ix2 = buildRegisterSessionKeyInstruction({
      vaultPda, sessionPubkey: new Uint8Array(32).fill(1), maxAmount: 1n,
      expiresAt: 4_000_000_000n, allowedCounterparty: counterparty, nonce: 0,
      maxRevolvingCapacity: 1n, swigAddress, vaultUsdcAta, payer,
      siblingSessionPdas: [], clientDataJSON: new Uint8Array(1), authenticatorData: new Uint8Array(37),
    });
    expect(ix2.keys.length).toBe(8);
  });
});
