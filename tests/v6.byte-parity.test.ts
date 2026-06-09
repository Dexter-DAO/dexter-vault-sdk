import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { DISCRIMINATORS, SESSION_ACCOUNT_DISCRIMINATOR } from '../src/constants/index.js';

const idl = JSON.parse(
  readFileSync(new URL('../src/idl/dexter_vault.json', import.meta.url), 'utf8'),
);

function idlDisc(name: string): number[] {
  const ix = idl.instructions.find((i: { name: string }) => i.name === name);
  if (!ix) throw new Error(`instruction ${name} not in IDL`);
  return ix.discriminator;
}

describe('discriminators match the V6 IDL', () => {
  it('every DISCRIMINATORS entry equals the IDL value', () => {
    for (const [name, bytes] of Object.entries(DISCRIMINATORS)) {
      expect(Array.from(bytes), name).toEqual(idlDisc(name));
    }
  });

  it('migration discriminators present', () => {
    expect(Array.from(DISCRIMINATORS.migrate_v5_to_v6)).toEqual([25, 38, 151, 206, 59, 103, 141, 175]);
    expect(Array.from(DISCRIMINATORS.migrate_v5_to_v6_with_session)).toEqual([225, 119, 165, 163, 251, 174, 42, 15]);
  });

  it('SessionAccount account discriminator matches IDL', () => {
    const acct = idl.accounts.find((a: { name: string }) => a.name === 'SessionAccount');
    expect(Array.from(SESSION_ACCOUNT_DISCRIMINATOR)).toEqual(acct.discriminator);
  });
});
