import { describe, it, expect } from 'vitest';
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import {
  buildOpenStandbyInstruction,
  buildSetStandbyReserveInstruction,
  buildCloseStandbyInstruction,
  deriveStandbyBackerPda,
} from '../src/instructions/credit.js';
import { deriveSwigWalletAddress } from '../src/instructions/withdraw.js';
import { patchSwigWalletSigner } from '../src/tab/assembleStandbyReserveSignV2.js';
import { setStandbyReserve, closeStandby } from '../src/tab/credit.js';
import { buildCloseStandbyMessage } from '../src/messages/operations.js';
import { DISCRIMINATORS, INSTRUCTIONS_SYSVAR_ID, SECP256R1_PROGRAM_ID } from '../src/constants/index.js';

const FIN = new PublicKey('11111111111111111111111111111112');
const VAULT = new PublicKey('11111111111111111111111111111113');

describe('buildOpenStandbyInstruction (Phase-1 reserve account)', () => {
  it('includes standby_backer at index 2, sysvar at index 3', () => {
    const ix = buildOpenStandbyInstruction({
      vaultPda: VAULT, financierSwig: FIN, cap: 5_000_000n,
      clientDataJSON: new Uint8Array([1]), authenticatorData: new Uint8Array([2]),
    });
    const backer = deriveStandbyBackerPda(FIN);
    expect(ix.keys.length).toBe(4);
    expect(ix.keys[0].pubkey.equals(VAULT)).toBe(true);
    expect(ix.keys[1].pubkey.equals(FIN)).toBe(true);
    expect(ix.keys[2].pubkey.equals(backer)).toBe(true);
    expect(ix.keys[2].isWritable).toBe(true);
    expect(ix.keys[3].pubkey.equals(INSTRUCTIONS_SYSVAR_ID)).toBe(true);
  });
});

describe('buildSetStandbyReserveInstruction (mechanism B)', () => {
  it('correct accounts + financier_swig_wallet is a SIGNER + no sysvar', () => {
    const FEE = new PublicKey('11111111111111111111111111111114');
    const ix = buildSetStandbyReserveInstruction({
      financierSwig: FIN, feePayer: FEE, newReserve: 10_000_000n,
    });
    const wallet = deriveSwigWalletAddress(FIN);
    const backer = deriveStandbyBackerPda(FIN);
    expect(ix.keys.length).toBe(5);
    expect(Buffer.from(ix.data.subarray(0,8))).toEqual(Buffer.from(DISCRIMINATORS.set_standby_reserve));
    expect(ix.keys[0].pubkey.equals(FIN)).toBe(true);
    expect(ix.keys[1].pubkey.equals(wallet)).toBe(true);
    expect(ix.keys[1].isSigner).toBe(true);
    expect(ix.keys[2].pubkey.equals(backer)).toBe(true);
    expect(ix.keys[2].isWritable).toBe(true);
    expect(ix.keys[3].pubkey.equals(FEE)).toBe(true);
    expect(ix.keys[3].isSigner).toBe(true);
    expect(ix.keys[3].isWritable).toBe(true);
    expect(ix.keys[4].pubkey.equals(SystemProgram.programId)).toBe(true);
    expect(ix.keys.some(k => k.pubkey.equals(INSTRUCTIONS_SYSVAR_ID))).toBe(false);
    expect(ix.data.length).toBe(16); // 8 disc + 8 u64
  });
});

describe('buildCloseStandbyInstruction', () => {
  it('financier leg: correct 5 accounts incl standby_backer + keeps sysvar, closer byte = 1', () => {
    const ix = buildCloseStandbyInstruction({
      closer: 'financier', vaultPda: VAULT, financierSwig: FIN,
      clientDataJSON: new Uint8Array(), authenticatorData: new Uint8Array(),
    });
    const wallet = deriveSwigWalletAddress(FIN);
    const backer = deriveStandbyBackerPda(FIN);
    expect(ix.keys.length).toBe(5);
    expect(Buffer.from(ix.data.subarray(0,8))).toEqual(Buffer.from(DISCRIMINATORS.close_standby));
    expect(ix.data[8]).toBe(1); // closer: financier = 1
    expect(ix.keys[0].pubkey.equals(FIN)).toBe(true);
    expect(ix.keys[1].pubkey.equals(wallet)).toBe(true);
    expect(ix.keys[1].isSigner).toBe(false); // raw ix: AccountInfo, signer-patch happens in the assembler
    expect(ix.keys[2].pubkey.equals(VAULT)).toBe(true);
    expect(ix.keys[2].isWritable).toBe(true);
    expect(ix.keys[3].pubkey.equals(backer)).toBe(true);
    expect(ix.keys[3].isWritable).toBe(true);
    expect(ix.keys[4].pubkey.equals(INSTRUCTIONS_SYSVAR_ID)).toBe(true);
  });
  it('user leg: closer variant byte = 0', () => {
    const ix = buildCloseStandbyInstruction({
      closer: 'user', vaultPda: VAULT, financierSwig: FIN,
      clientDataJSON: new Uint8Array([9]), authenticatorData: new Uint8Array([8]),
    });
    expect(ix.data[8]).toBe(0);
  });
});

describe('patchSwigWalletSigner (mechanism-B signer patch)', () => {
  const SWIG_WALLET = new PublicKey('11111111111111111111111111111115');
  function fakeCloseIx(): TransactionInstruction {
    return new TransactionInstruction({
      programId: VAULT,
      keys: [
        { pubkey: FIN, isSigner: false, isWritable: false },
        { pubkey: SWIG_WALLET, isSigner: false, isWritable: false }, // close emits false
        { pubkey: VAULT, isSigner: false, isWritable: true },
      ],
      data: Buffer.from([]),
    });
  }
  it('flips the swig_wallet meta to isSigner:true (close_standby leg)', () => {
    const ix = fakeCloseIx();
    patchSwigWalletSigner(ix, SWIG_WALLET);
    expect(ix.keys[1].isSigner).toBe(true);
    expect(ix.keys[0].isSigner).toBe(false); // others untouched
    expect(ix.keys[2].isWritable).toBe(true); // writable untouched
  });
  it('is idempotent (set_standby_reserve already isSigner:true)', () => {
    const ix = new TransactionInstruction({
      programId: VAULT,
      keys: [{ pubkey: SWIG_WALLET, isSigner: true, isWritable: false }],
      data: Buffer.from([]),
    });
    patchSwigWalletSigner(ix, SWIG_WALLET);
    expect(ix.keys[0].isSigner).toBe(true);
  });
  it('throws if swig_wallet not present (wrong-ix guard)', () => {
    const ix = new TransactionInstruction({
      programId: VAULT, keys: [{ pubkey: FIN, isSigner: false, isWritable: false }], data: Buffer.from([]),
    });
    expect(() => patchSwigWalletSigner(ix, SWIG_WALLET)).toThrow(/not found in inner ix/);
  });

  // real-shape lock: set_standby_reserve's JSDoc claims it already emits
  // swig_wallet isSigner:true (struct Signer) — assert against the ACTUAL ix.
  it('leaves set_standby_reserve swig_wallet signer untouched (real ix shape)', () => {
    const ix = buildSetStandbyReserveInstruction({ financierSwig: FIN, feePayer: VAULT, newReserve: 1n });
    const wallet = deriveSwigWalletAddress(FIN);
    patchSwigWalletSigner(ix, wallet);
    expect(ix.keys[1].isSigner).toBe(true);
  });
});

describe('buildCloseStandbyMessage', () => {
  it('is 77 bytes: "close_standby"(13) || vault(32) || financier(32)', () => {
    const msg = buildCloseStandbyMessage(VAULT, FIN);
    expect(msg.length).toBe(77);
    expect(Buffer.from(msg.subarray(0, 13)).toString('utf8')).toBe('close_standby');
    expect(Buffer.from(msg.subarray(13, 45))).toEqual(Buffer.from(VAULT.toBytes()));
    expect(Buffer.from(msg.subarray(45, 77))).toEqual(Buffer.from(FIN.toBytes()));
  });
});

describe('setStandbyReserve / closeStandby (tab wrappers, mechanism B)', () => {
  const FEE = new PublicKey('11111111111111111111111111111114');
  // injected fake assembler: capture the args, return a single marker ix
  function fakeAssembler() {
    const seen: any = {};
    const fn = async (a: any) => {
      seen.vaultIx = a.vaultIx;
      seen.programRoleId = a.programRoleId;
      seen.financierSwig = a.financierSwig;
      seen.feePayer = a.feePayer;
      return [new TransactionInstruction({ programId: FIN, keys: [], data: Buffer.from([0xab]) })];
    };
    return { fn, seen };
  }

  it('setStandbyReserve returns ONLY the assembler output + passes a set_standby_reserve vaultIx + programRoleId', async () => {
    const { fn, seen } = fakeAssembler();
    const ixs = await setStandbyReserve({
      connection: {} as any, financierSwig: FIN, feePayer: FEE, newReserve: 7n,
      programRoleId: 4, assembleStandbyReserveSignV2: fn,
    });
    // mechanism B: no prepended vaultIx — returns the fake's output verbatim
    expect(ixs.length).toBe(1);
    expect(Array.from(ixs[0].data)).toEqual([0xab]);
    // the fake received the right vault ix + role
    expect(Buffer.from(seen.vaultIx.data.subarray(0, 8)))
      .toEqual(Buffer.from(DISCRIMINATORS.set_standby_reserve));
    expect(seen.programRoleId).toBe(4);
    expect(seen.financierSwig.equals(FIN)).toBe(true);
    expect(seen.feePayer.equals(FEE)).toBe(true);
  });

  it('closeStandby user leg returns [precompile, close{user}] (byte=0), precompile first', async () => {
    const ixs = await closeStandby({
      connection: {} as any, vaultPda: VAULT, financierSwig: FIN, feePayer: FEE, closer: 'user',
      userPasskey: {
        publicKey: new Uint8Array(33),
        signature: new Uint8Array(64),
        precompileMessage: buildCloseStandbyMessage(VAULT, FIN),
        clientDataJSON: new Uint8Array([1]),
        authenticatorData: new Uint8Array([2]),
      },
    });
    expect(ixs.length).toBe(2);
    expect(ixs[0].programId.equals(SECP256R1_PROGRAM_ID)).toBe(true); // precompile immediately precedes
    expect(Buffer.from(ixs[1].data.subarray(0, 8))).toEqual(Buffer.from(DISCRIMINATORS.close_standby));
    expect(ixs[1].data[8]).toBe(0); // user byte
  });

  it('closeStandby financier leg returns ONLY assembler output + passes close{financier} vaultIx (byte=1)', async () => {
    const { fn, seen } = fakeAssembler();
    const ixs = await closeStandby({
      connection: {} as any, vaultPda: VAULT, financierSwig: FIN, feePayer: FEE,
      closer: 'financier', programRoleId: 9, assembleStandbyReserveSignV2: fn,
    });
    expect(ixs.length).toBe(1);
    expect(Array.from(ixs[0].data)).toEqual([0xab]);
    expect(Buffer.from(seen.vaultIx.data.subarray(0, 8))).toEqual(Buffer.from(DISCRIMINATORS.close_standby));
    expect(seen.vaultIx.data[8]).toBe(1); // financier byte
    expect(seen.programRoleId).toBe(9);
  });

  it('closeStandby user leg without userPasskey throws', async () => {
    await expect(closeStandby({
      connection: {} as any, vaultPda: VAULT, financierSwig: FIN, feePayer: FEE, closer: 'user',
    })).rejects.toThrow(/requires userPasskey/);
  });

  it('closeStandby financier leg without programRoleId throws', async () => {
    await expect(closeStandby({
      connection: {} as any, vaultPda: VAULT, financierSwig: FIN, feePayer: FEE, closer: 'financier',
    })).rejects.toThrow(/requires programRoleId/);
  });
});
