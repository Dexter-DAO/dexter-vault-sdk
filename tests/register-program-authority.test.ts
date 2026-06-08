import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { buildRegisterProgramAuthority } from '../src/instructions/registerProgramAuthority.js';

const SWIG = new PublicKey('11111111111111111111111111111112');
const VAULT_PROG = new PublicKey('Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc');
const FEE = new PublicKey('11111111111111111111111111111114');

// Minimal fake Connection (only needs to satisfy getRpc's endpoint extraction).
const fakeConnection: any = { rpcEndpoint: 'https://example.invalid' };

describe('buildRegisterProgramAuthority', () => {
  it('returns roleId = current role count, and the add ix(s)', async () => {
    let capturedActions: any, capturedAuthInfo: any, capturedSignerRole: any;
    const result = await buildRegisterProgramAuthority({
      connection: fakeConnection,
      financierSwig: SWIG,
      vaultProgramId: VAULT_PROG,
      feePayer: FEE,
      authorityPubkey: FEE,
      // injected fakes:
      _fetchSwig: (async () => ({ roles: [{}, {}, {}] }) as any) as any, // 3 existing roles → new role = 3
      _getAddAuthorityInstructions: (async (
        _swig: any,
        signerRole: number,
        authInfo: any,
        actions: any,
      ) => {
        capturedSignerRole = signerRole;
        capturedAuthInfo = authInfo;
        capturedActions = actions;
        return [
          {
            programAddress: '11111111111111111111111111111111',
            accounts: [],
            data: new Uint8Array([7]),
          },
        ];
      }) as any,
    });
    expect(result.roleId).toBe(3); // count-before-add
    expect(result.instructions.length).toBe(1); // bridged to web3
    expect(result.instructions[0].programId).toBeInstanceOf(PublicKey);
    expect(capturedSignerRole).toBe(0); // role 0 (manageAuthority) signs the add
    expect(capturedActions).toBeDefined(); // the programLimit actions object
    expect(capturedAuthInfo).toBeDefined(); // the ed25519 authority info
  });

  it('throws if the swig is not found', async () => {
    await expect(
      buildRegisterProgramAuthority({
        connection: fakeConnection,
        financierSwig: SWIG,
        vaultProgramId: VAULT_PROG,
        feePayer: FEE,
        authorityPubkey: FEE,
        _fetchSwig: (async () => null) as any,
      }),
    ).rejects.toThrow(/not (found|visible)/i);
  });

  it('binds the Ed25519 authority to the explicit authorityPubkey (not feePayer)', async () => {
    const AUTH = new PublicKey('11111111111111111111111111111116');

    // Build with authorityPubkey=AUTH and capture the real authInfo handed to
    // getAddAuthorityInstructions. createEd25519AuthorityInfo returns
    // { data: Uint8Array(32), type: 1 } where data === the bound pubkey's bytes.
    const run = async (authorityPubkey: PublicKey) => {
      let capturedAuthInfo: any;
      const result = await buildRegisterProgramAuthority({
        connection: fakeConnection,
        financierSwig: SWIG,
        vaultProgramId: VAULT_PROG,
        feePayer: FEE,
        authorityPubkey,
        _fetchSwig: (async () => ({ roles: [{}] })) as any,
        _getAddAuthorityInstructions: (async (_swig: any, _role: number, authInfo: any) => {
          capturedAuthInfo = authInfo;
          return [
            { programAddress: '11111111111111111111111111111111', accounts: [], data: new Uint8Array() },
          ];
        }) as any,
      });
      return { result, capturedAuthInfo };
    };

    const { result, capturedAuthInfo } = await run(AUTH);
    expect(result.roleId).toBe(1);
    expect(capturedAuthInfo).toBeDefined();

    // The authInfo embeds the EXPLICIT authorityPubkey's 32 bytes — assert they
    // equal AUTH.toBytes() (the binding came from authorityPubkey, not feePayer).
    const authData = Buffer.from(capturedAuthInfo.data as Uint8Array);
    expect(authData.equals(Buffer.from(AUTH.toBytes()))).toBe(true);
    expect(authData.equals(Buffer.from(FEE.toBytes()))).toBe(false);

    // Cross-check: a second build bound to FEE produces a DIFFERENT authInfo whose
    // bytes equal FEE — proving the binding tracks authorityPubkey, not a constant.
    const { capturedAuthInfo: feeAuthInfo } = await run(FEE);
    const feeData = Buffer.from(feeAuthInfo.data as Uint8Array);
    expect(feeData.equals(Buffer.from(FEE.toBytes()))).toBe(true);
    expect(authData.equals(feeData)).toBe(false);
  });
});
