import { describe, test, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { deriveSessionPda } from '../src/session/index.js';
import { DEXTER_VAULT_PROGRAM_ID, SESSION_SEED } from '../src/constants/index.js';

describe('deriveSessionPda', () => {
  test('matches findProgramAddressSync over [b"session", vault, counterparty]', () => {
    const vault = new PublicKey('So11111111111111111111111111111111111111112');
    const counterparty = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    const [expected, expectedBump] = PublicKey.findProgramAddressSync(
      [SESSION_SEED, vault.toBuffer(), counterparty.toBuffer()],
      DEXTER_VAULT_PROGRAM_ID,
    );
    const [pda, bump] = deriveSessionPda(vault, counterparty);
    expect(pda.equals(expected)).toBe(true);
    expect(bump).toBe(expectedBump);
  });

  test('golden PDA: hardcoded literal pins SESSION_SEED + default program ID', () => {
    const vault = new PublicKey('So11111111111111111111111111111111111111112');
    const counterparty = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    const [pda, bump] = deriveSessionPda(vault, counterparty);
    expect(pda.toBase58()).toBe('9ZASMwmLokigsB5krjeFTmnRKxT73qL9y7xfgqk4o3YR');
    expect(bump).toBe(252);
  });

  test('different counterparty → different PDA', () => {
    const vault = new PublicKey('So11111111111111111111111111111111111111112');
    const a = deriveSessionPda(vault, PublicKey.unique())[0];
    const b = deriveSessionPda(vault, PublicKey.unique())[0];
    expect(a.equals(b)).toBe(false);
  });
});
