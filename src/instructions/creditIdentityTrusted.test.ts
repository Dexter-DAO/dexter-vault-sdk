import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import {
  VAULT_ACCOUNT_DISCRIMINATOR,
  VAULT_ACCOUNT_DISCRIMINATOR_B58,
  DISCRIMINATORS,
  INTERIM_ROOT_AUTHORITY,
  DEXTER_VAULT_PROGRAM_ID,
} from '../constants/index.js';
import { buildEstablishCreditRootTrustedInstruction } from './creditIdentity.js';
import { deriveCreditRootPda } from '../credit/derive.js';

describe('Vault account discriminator', () => {
  it('equals sha256("account:Vault")[..8]', () => {
    const expected = Uint8Array.from(
      createHash('sha256').update('account:Vault').digest().subarray(0, 8),
    );
    expect([...VAULT_ACCOUNT_DISCRIMINATOR]).toEqual([...expected]);
  });

  it('b58 string is pinned to bs58.encode(discriminator)', () => {
    expect(VAULT_ACCOUNT_DISCRIMINATOR_B58).toBe(bs58.encode(VAULT_ACCOUNT_DISCRIMINATOR));
  });
});

describe('buildEstablishCreditRootTrustedInstruction', () => {
  const nullifier = Uint8Array.from({ length: 32 }, (_, i) => i + 1);

  it('serializes discriminator + 32-byte nullifier (40 bytes total)', () => {
    const ix = buildEstablishCreditRootTrustedInstruction({ nullifier });
    expect(ix.data.length).toBe(40);
    expect([...ix.data.subarray(0, 8)]).toEqual([
      ...DISCRIMINATORS.establish_credit_root_trusted,
    ]);
    expect([...ix.data.subarray(8)]).toEqual([...nullifier]);
  });

  it('has the 3 IDL accounts in order; authority defaults to INTERIM_ROOT_AUTHORITY', () => {
    const ix = buildEstablishCreditRootTrustedInstruction({ nullifier });
    const [creditRoot] = deriveCreditRootPda(nullifier);
    expect(ix.programId.equals(DEXTER_VAULT_PROGRAM_ID)).toBe(true);
    expect(ix.keys).toHaveLength(3);
    // [0] credit_root — writable, not signer
    expect(ix.keys[0]!.pubkey.equals(creditRoot)).toBe(true);
    expect(ix.keys[0]!.isWritable).toBe(true);
    expect(ix.keys[0]!.isSigner).toBe(false);
    // [1] authority — writable signer, defaults to INTERIM_ROOT_AUTHORITY
    expect(ix.keys[1]!.pubkey.equals(INTERIM_ROOT_AUTHORITY)).toBe(true);
    expect(ix.keys[1]!.isSigner).toBe(true);
    expect(ix.keys[1]!.isWritable).toBe(true);
    // [2] system_program
    expect(ix.keys[2]!.pubkey.equals(SystemProgram.programId)).toBe(true);
  });

  it('honors a custom authority override', () => {
    const custom = new PublicKey('11111111111111111111111111111112');
    const ix = buildEstablishCreditRootTrustedInstruction({ nullifier, authority: custom });
    expect(ix.keys[1]!.pubkey.equals(custom)).toBe(true);
  });

  it('rejects a non-32-byte nullifier', () => {
    expect(() =>
      buildEstablishCreditRootTrustedInstruction({ nullifier: new Uint8Array(31) }),
    ).toThrow(/32 bytes/);
  });
});
