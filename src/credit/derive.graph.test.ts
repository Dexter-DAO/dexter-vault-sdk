import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { derivePrincipalNodePda, deriveGraphConfigPda } from './derive.js';
import { DEXTER_VAULT_PROGRAM_ID } from '../constants/index.js';

describe('derivePrincipalNodePda', () => {
  it("matches [b'principal', node_id] over the program id", () => {
    const nodeId = new Uint8Array(32);
    nodeId[0] = 42;
    const [pda, bump] = derivePrincipalNodePda(nodeId);
    const [expected, expectedBump] = PublicKey.findProgramAddressSync(
      [Buffer.from('principal'), Buffer.from(nodeId)],
      DEXTER_VAULT_PROGRAM_ID,
    );
    expect(pda.toBase58()).toBe(expected.toBase58());
    expect(bump).toBe(expectedBump);
  });

  it('rejects a node_id that is not 32 bytes', () => {
    expect(() => derivePrincipalNodePda(new Uint8Array(31))).toThrow();
  });
});

describe('deriveGraphConfigPda', () => {
  it("matches [b'graph_config'] over the program id", () => {
    const [pda, bump] = deriveGraphConfigPda();
    const [expected, expectedBump] = PublicKey.findProgramAddressSync(
      [Buffer.from('graph_config')],
      DEXTER_VAULT_PROGRAM_ID,
    );
    expect(pda.toBase58()).toBe(expected.toBase58());
    expect(bump).toBe(expectedBump);
  });
});
