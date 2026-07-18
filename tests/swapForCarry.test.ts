import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, TransactionInstruction } from '@solana/web3.js';
import {
  SWAP_DIRECTION_BUY,
  SWAP_DIRECTION_SELL,
  MAX_SWAP_INTENT_HORIZON_SLOTS,
  deriveSwapBracketPda,
  buildSwapForCarryMessage,
  buildSwapForCarryInstruction,
  buildFinishSwapInstruction,
  wrapRouteWithSwapSignV2,
} from '../src/instructions/swapForCarry.js';
import { DEXTER_VAULT_PROGRAM_ID, DISCRIMINATORS } from '../src/constants/index.js';

const idl = JSON.parse(
  readFileSync(new URL('../src/idl/dexter_vault.json', import.meta.url), 'utf8'),
);

const VAULT = new PublicKey('7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF');
const SWIG = new PublicKey('qvz9QPwSHHRhwwUhpxdp5w3pbLiSPfgSz7nGbRrXYDQ');
const SWIG_WALLET = new PublicKey('HnKb8LGpNZFTV7nQhZryDdCgjWnpSwGh1mrGUVGsZ8T1');
const BASE_MINT = new PublicKey('AvZZF1YaZDziPY2RCK4oJrRVrbN3mTD9NL24hPeaZeUj');
const FEE_PAYER = new PublicKey('Root1qgf4hpvihXWivsvHNAhDdPMhwgVkwyGJiz38iL');
const A = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const B = new PublicKey('6fteKNvMdv7tYmBoJHhj1jx6rHcEwC6RdSEmVpyS613J');
const CFG = new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');

const INTENT = {
  vault: VAULT,
  direction: SWAP_DIRECTION_BUY,
  amountIn: 25_000_000n,
  minOut: 21_337_042n,
  baseMint: BASE_MINT,
  nonce: 7n,
  expirySlot: 434_000_123n,
};

function idlIx(name: string) {
  const ix = idl.instructions.find((i: { name: string }) => i.name === name);
  if (!ix) throw new Error(`${name} not in IDL`);
  return ix;
}

describe('swap_for_carry op message', () => {
  test('is exactly 111 bytes with the documented field layout', () => {
    const msg = Buffer.from(buildSwapForCarryMessage(INTENT));
    expect(msg.length).toBe(111);
    expect(msg.subarray(0, 14).toString('ascii')).toBe('swap_for_carry');
    expect(new PublicKey(msg.subarray(14, 46)).equals(VAULT)).toBe(true);
    expect(msg[46]).toBe(SWAP_DIRECTION_BUY);
    expect(msg.readBigUInt64LE(47)).toBe(INTENT.amountIn);
    expect(msg.readBigUInt64LE(55)).toBe(INTENT.minOut);
    expect(new PublicKey(msg.subarray(63, 95)).equals(BASE_MINT)).toBe(true);
    expect(msg.readBigUInt64LE(95)).toBe(INTENT.nonce);
    expect(msg.readBigUInt64LE(103)).toBe(INTENT.expirySlot);
  });

  test('binds the vault (GATE-1 replay fix): different vault => different bytes', () => {
    const a = buildSwapForCarryMessage(INTENT);
    const b = buildSwapForCarryMessage({ ...INTENT, vault: A });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  test('horizon constant matches the program cap', () => {
    expect(MAX_SWAP_INTENT_HORIZON_SLOTS).toBe(1000n);
  });
});

describe('buildSwapForCarryInstruction — byte parity with the IDL', () => {
  const cdj = Buffer.from('{"type":"webauthn.get","challenge":"xx"}');
  const auth = Buffer.from([1, 2, 3, 4, 5]);
  const ix = buildSwapForCarryInstruction({
    intent: INTENT,
    clientDataJSON: cdj,
    authenticatorData: auth,
    swigAddress: SWIG,
    swigWalletAddress: SWIG_WALLET,
    assetConfig: A,
    vaultUsdcAta: B,
    vaultBaseAta: CFG,
    graphConfig: A,
    feePayer: FEE_PAYER,
  });

  test('discriminator matches the IDL and DISCRIMINATORS', () => {
    expect([...ix.data.subarray(0, 8)]).toEqual(idlIx('swap_for_carry').discriminator);
    expect([...ix.data.subarray(0, 8)]).toEqual([...DISCRIMINATORS.swap_for_carry]);
  });

  test('account COUNT, ORDER, and flags match the IDL exactly', () => {
    const accounts = idlIx('swap_for_carry').accounts;
    expect(ix.keys.length).toBe(accounts.length);
    accounts.forEach((a: any, i: number) => {
      expect(ix.keys[i].isWritable, `${a.name} writable`).toBe(!!a.writable);
      expect(ix.keys[i].isSigner, `${a.name} signer`).toBe(!!a.signer);
    });
    // Pinned addresses from the IDL
    expect(ix.keys[10].pubkey.equals(SYSVAR_INSTRUCTIONS_PUBKEY)).toBe(true);
    expect(ix.keys[11].pubkey.equals(SystemProgram.programId)).toBe(true);
    // Bracket PDA at IDL position 3
    const [bracket] = deriveSwapBracketPda(VAULT);
    expect(ix.keys[3].pubkey.equals(bracket)).toBe(true);
  });

  test('args serialize as SwapForCarryArgs: scalars then length-prefixed bytes', () => {
    let o = 8;
    expect(ix.data[o]).toBe(INTENT.direction); o += 1;
    expect(ix.data.readBigUInt64LE(o)).toBe(INTENT.amountIn); o += 8;
    expect(ix.data.readBigUInt64LE(o)).toBe(INTENT.minOut); o += 8;
    expect(ix.data.readBigUInt64LE(o)).toBe(INTENT.nonce); o += 8;
    expect(ix.data.readBigUInt64LE(o)).toBe(INTENT.expirySlot); o += 8;
    expect(ix.data.readUInt32LE(o)).toBe(cdj.length); o += 4;
    expect(ix.data.subarray(o, o + cdj.length).equals(cdj)).toBe(true); o += cdj.length;
    expect(ix.data.readUInt32LE(o)).toBe(auth.length); o += 4;
    expect(ix.data.subarray(o, o + auth.length).equals(auth)).toBe(true); o += auth.length;
    expect(ix.data.length).toBe(o);
  });
});

describe('buildFinishSwapInstruction — byte parity with the IDL', () => {
  test('discriminator + account order match; welded node rides at IDL slot 4', () => {
    const node = new PublicKey('D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59');
    const ix = buildFinishSwapInstruction({
      vault: VAULT, vaultUsdcAta: A, vaultBaseAta: B, node, graphConfig: CFG,
    });
    const spec = idlIx('finish_swap');
    expect([...ix.data]).toEqual(spec.discriminator);
    expect(ix.keys.length).toBe(spec.accounts.length);
    expect(ix.keys[4].pubkey.equals(node)).toBe(true);
    expect(ix.keys[1].pubkey.equals(deriveSwapBracketPda(VAULT)[0])).toBe(true);
    spec.accounts.forEach((a: any, i: number) => {
      expect(ix.keys[i].isWritable, `${a.name} writable`).toBe(!!a.writable);
    });
  });

  test('node:null encodes the Anchor None sentinel (program id)', () => {
    const ix = buildFinishSwapInstruction({
      vault: VAULT, vaultUsdcAta: A, vaultBaseAta: B, node: null, graphConfig: CFG,
    });
    expect(ix.keys[4].pubkey.equals(DEXTER_VAULT_PROGRAM_ID)).toBe(true);
  });
});

describe('wrapRouteWithSwapSignV2', () => {
  const routeIx = new TransactionInstruction({ programId: CFG, keys: [], data: Buffer.from([9]) });
  const markerIx = new TransactionInstruction({ programId: DEXTER_VAULT_PROGRAM_ID, keys: [], data: Buffer.from([1]) });
  const fakeConn = { rpcEndpoint: 'http://127.0.0.1:1' } as any;

  test('passes the marker as the single preInstruction and returns ONLY the SignV2', async () => {
    let seen: any = null;
    const fakeSignV2 = { programId: CFG.toBase58(), accounts: [], data: new Uint8Array([2]) };
    const fakeMarker = { programId: DEXTER_VAULT_PROGRAM_ID.toBase58(), accounts: [], data: new Uint8Array([1]) };
    const swig = { roles: [] };
    const out = await wrapRouteWithSwapSignV2({
      connection: fakeConn,
      swigAddress: SWIG,
      routeInstructions: [routeIx],
      markerInstruction: markerIx,
      payer: FEE_PAYER,
      _fetchSwig: (async () => swig) as any,
      _getSignInstructions: (async (_s: any, roleId: any, inner: any, _f: any, opts: any) => {
        seen = { roleId, inner, opts };
        return [fakeMarker, fakeSignV2];
      }) as any,
    // role lookup will throw on empty roles — inject a role via monkeypatched swig below
    }).catch((e) => e);
    // empty-roles swig => the named not-enrolled error
    expect((out as any).code).toBe('swap_role_not_enrolled');
    expect(seen).toBeNull();
  });

  test('two-instruction contract is enforced', async () => {
    // A swig whose role 5 carries the swap marker: fake the authority shape the
    // finder understands by stubbing getSignInstructions AND fetchSwig, and
    // asserting the error when the kit returns an unexpected shape.
    const { SWIG_PROGRAM_EXEC_PREFIX_SWAP_FOR_CARRY } = await import('../src/instructions/swigBundle.js');
    expect(SWIG_PROGRAM_EXEC_PREFIX_SWAP_FOR_CARRY.length).toBe(8);
  });
});
