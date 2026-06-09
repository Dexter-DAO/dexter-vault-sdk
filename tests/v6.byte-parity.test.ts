import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  DISCRIMINATORS,
  SESSION_ACCOUNT_DISCRIMINATOR,
  SESSION_ACCOUNT_SIZE,
} from '../src/constants/index.js';

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
