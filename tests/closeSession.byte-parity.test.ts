import { describe, it, expect } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { buildCloseSessionInstruction } from '../src/instructions/closeSession.js';
import { deriveSessionPda } from '../src/session/derive.js';
import { DISCRIMINATORS, DEXTER_VAULT_PROGRAM_ID } from '../src/constants/index.js';
import idl from '../src/idl/dexter_vault.json';

const VAULT = Keypair.generate().publicKey;
const SELLER = Keypair.generate().publicKey;
const AUTHORITY = Keypair.generate().publicKey;

describe('buildCloseSessionInstruction', () => {
  it('discriminator matches the program IDL', () => {
    const entry = (idl as any).instructions.find((i: any) => i.name === 'close_session');
    expect(entry, 'close_session missing from bundled IDL — refresh src/idl from dexter-vault target/idl').toBeTruthy();
    expect(Array.from(DISCRIMINATORS.close_session)).toEqual(entry.discriminator);
  });

  it('data = disc(8) || allowed_counterparty(32)', () => {
    const ix = buildCloseSessionInstruction({
      vaultPda: VAULT,
      allowedCounterparty: SELLER,
      dexterAuthority: AUTHORITY,
    });
    expect(ix.data.length).toBe(40);
    expect(ix.data.subarray(0, 8).equals(Buffer.from(DISCRIMINATORS.close_session))).toBe(true);
    expect(ix.data.subarray(8).equals(Buffer.from(SELLER.toBytes()))).toBe(true);
  });

  it('accounts: vault(ro), session PDA(w), dexter_authority(signer, w); program id pinned', () => {
    const ix = buildCloseSessionInstruction({
      vaultPda: VAULT,
      allowedCounterparty: SELLER,
      dexterAuthority: AUTHORITY,
    });
    const [sessionPda] = deriveSessionPda(VAULT, SELLER);
    expect(ix.programId.equals(DEXTER_VAULT_PROGRAM_ID)).toBe(true);
    expect(ix.keys.length).toBe(3);
    expect(ix.keys[0]).toMatchObject({ pubkey: VAULT, isSigner: false, isWritable: false });
    expect(ix.keys[1].pubkey.equals(sessionPda)).toBe(true);
    expect(ix.keys[1]).toMatchObject({ isSigner: false, isWritable: true });
    expect(ix.keys[2]).toMatchObject({ pubkey: AUTHORITY, isSigner: true, isWritable: true });
  });
});
