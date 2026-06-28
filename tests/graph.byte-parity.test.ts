/**
 * Byte-parity / account-order tests for the depth-N recourse-graph builders
 * (Task 13). Mirrors tests/credit.byte-parity.test.ts but drives every
 * assertion off the SYNCED IDL (src/idl/dexter_vault.json) as the source of
 * truth: discriminator, account order (name/signer/writable), the
 * event_authority+program emit_cpi! pair (and its ABSENCE on set_pause),
 * optional-account gating, and the arg buffer layout.
 *
 * These are characterization tests — they lock in behavior the reviewer
 * hand-verified. A FAILURE here means a builder drifted from the program.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import {
  buildCreateNodeInstruction,
  buildAttachNodeInstruction,
  buildAttachRootInstruction,
  buildEmancipateInstruction,
  buildSetFreezeInstruction,
  buildSetPauseInstruction,
  buildSeizeAncestorInstruction,
  buildInitGraphConfigInstruction,
  type RateCapInput,
} from '../src/instructions/credit.js';
import { deriveSwigWalletAddress } from '../src/instructions/withdraw.js';
import {
  derivePrincipalNodePda,
  deriveGraphConfigPda,
  deriveEventAuthorityPda,
} from '../src/credit/derive.js';
import { DEXTER_VAULT_PROGRAM_ID, INSTRUCTIONS_SYSVAR_ID } from '../src/constants/index.js';

const idl = JSON.parse(
  readFileSync(new URL('../src/idl/dexter_vault.json', import.meta.url), 'utf8'),
);

interface IdlAccount { name: string; signer: boolean; writable: boolean; optional: boolean }

function idlIx(name: string): { discriminator: number[]; accounts: IdlAccount[] } {
  const ix = idl.instructions.find((i: { name: string }) => i.name === name);
  if (!ix) throw new Error(`instruction ${name} not in IDL`);
  return {
    discriminator: ix.discriminator,
    accounts: ix.accounts.map((a: any) => ({
      name: a.name,
      signer: !!a.signer,
      writable: !!a.writable,
      optional: !!a.optional,
    })),
  };
}

/**
 * Assert the leading `accounts.length` keys of `ix` match the IDL positionally
 * by signer/writable. `overrides[i]` replaces the IDL flags for slot i (used for
 * the Anchor "None ⇒ program-id sentinel, flags cleared" optional case).
 */
function expectAccountFlags(
  ix: { keys: any[]; data: Buffer | Uint8Array },
  name: string,
  overrides: Record<number, { signer: boolean; writable: boolean }> = {},
) {
  const { discriminator, accounts } = idlIx(name);
  // discriminator
  expect(Array.from((ix.data as Buffer).subarray(0, 8)), `${name} disc`).toEqual(discriminator);
  for (let i = 0; i < accounts.length; i++) {
    const exp = overrides[i] ?? { signer: accounts[i].signer, writable: accounts[i].writable };
    expect(ix.keys[i].isSigner, `${name}[${i}] ${accounts[i].name} isSigner`).toBe(exp.signer);
    expect(ix.keys[i].isWritable, `${name}[${i}] ${accounts[i].name} isWritable`).toBe(exp.writable);
  }
  return accounts;
}

// Distinct valid base58 pubkeys so positional assertions stay unambiguous.
const A = new PublicKey('SysvarRent111111111111111111111111111111111');
const B = new PublicKey('SysvarC1ock11111111111111111111111111111111');
const C = new PublicKey('So11111111111111111111111111111111111111112');
const D = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const E = new PublicKey('SysvarS1otHashes111111111111111111111111111');
const F = new PublicKey('SysvarS1otHistory11111111111111111111111111');

const [GRAPH_CONFIG] = deriveGraphConfigPda();
const [EVENT_AUTHORITY] = deriveEventAuthorityPda();

const NODE_ID = new Uint8Array(32).fill(7);
const NULLIFIER = new Uint8Array(32).fill(0x2f);

const CAP_WITH_CEILING: RateCapInput = {
  rateAmount: 1_000_000n,
  periodSecs: 86_400,
  bucket: 250_000n,
  lastRefill: 1_700_000_000n,
  ceiling: 9_999_999n,
  burstMultiple: 3,
};
const CAP_NO_CEILING: RateCapInput = { ...CAP_WITH_CEILING, ceiling: null };

function expectRateCap(data: Buffer, off: number, cap: RateCapInput): number {
  expect(data.readBigUInt64LE(off), 'rate_amount').toBe(cap.rateAmount);
  expect(data.readUInt32LE(off + 8), 'period_secs').toBe(cap.periodSecs);
  expect(data.readBigUInt64LE(off + 12), 'bucket').toBe(cap.bucket);
  expect(data.readBigInt64LE(off + 20), 'last_refill').toBe(cap.lastRefill);
  let p = off + 28;
  if (cap.ceiling === null) {
    expect(data[p], 'ceiling tag None').toBe(0);
    p += 1;
  } else {
    expect(data[p], 'ceiling tag Some').toBe(1);
    expect(data.readBigUInt64LE(p + 1), 'ceiling body').toBe(cap.ceiling);
    p += 9;
  }
  expect(data[p], 'burst_multiple').toBe(cap.burstMultiple);
  return p + 1; // cursor past RateCap
}

describe('init_graph_config builder ↔ IDL', () => {
  it('3 accounts, pubkey+pubkey+u8 args', () => {
    const ix = buildInitGraphConfigInstruction({
      authority: A,
      adminAuthority: B,
      pauseAuthority: C,
      maxDepthOverride: 5,
    });
    expect(ix.programId.equals(DEXTER_VAULT_PROGRAM_ID)).toBe(true);
    const accts = expectAccountFlags(ix, 'init_graph_config');
    expect(ix.keys.length).toBe(accts.length); // exactly 3, no event pair
    expect(ix.keys[0].pubkey.equals(GRAPH_CONFIG)).toBe(true);
    expect(ix.keys[1].pubkey.equals(A)).toBe(true);
    expect(ix.keys[2].pubkey.equals(SystemProgram.programId)).toBe(true);
    // disc(8) || admin(32) || pause(32) || max_depth(u8) = 73
    const data = ix.data as Buffer;
    expect(data.length).toBe(73);
    expect(data.subarray(8, 40).equals(B.toBuffer())).toBe(true);
    expect(data.subarray(40, 72).equals(C.toBuffer())).toBe(true);
    expect(data[72]).toBe(5);
  });

  it('defaults max_depth_override to 0', () => {
    const ix = buildInitGraphConfigInstruction({ authority: A, adminAuthority: B, pauseAuthority: C });
    expect((ix.data as Buffer)[72]).toBe(0);
  });
});

describe('create_node builder ↔ IDL', () => {
  it('delegate: parent_node writable + parent_controller signer, Option<pubkey>=Some', () => {
    const ix = buildCreateNodeInstruction({
      nodeId: NODE_ID,
      controller: A,
      payer: B,
      cap: CAP_WITH_CEILING,
      parentNode: C,
      parentController: D,
      financier: E,
    });
    const accts = expectAccountFlags(ix, 'create_node');
    expect(ix.keys.length).toBe(accts.length); // 9 incl event pair
    const [nodePda] = derivePrincipalNodePda(NODE_ID);
    expect(ix.keys[0].pubkey.equals(nodePda)).toBe(true);
    expect(ix.keys[1].pubkey.equals(A)).toBe(true); // controller
    expect(ix.keys[2].pubkey.equals(B)).toBe(true); // payer
    expect(ix.keys[3].pubkey.equals(C)).toBe(true); // parent_node
    expect(ix.keys[4].pubkey.equals(D)).toBe(true); // parent_controller
    expect(ix.keys[5].pubkey.equals(GRAPH_CONFIG)).toBe(true);
    expect(ix.keys[6].pubkey.equals(SystemProgram.programId)).toBe(true);
    expect(ix.keys[7].pubkey.equals(EVENT_AUTHORITY)).toBe(true);
    expect(ix.keys[8].pubkey.equals(DEXTER_VAULT_PROGRAM_ID)).toBe(true);
    // data: disc(8) || node_id(32) || RateCap(38, ceiling Some) || Option<pubkey> Some(33) || financier(32)
    const data = ix.data as Buffer;
    expect(data.subarray(8, 40).equals(Buffer.from(NODE_ID))).toBe(true);
    const afterCap = expectRateCap(data, 40, CAP_WITH_CEILING);
    expect(data[afterCap], 'parent Option tag Some').toBe(1);
    expect(data.subarray(afterCap + 1, afterCap + 33).equals(C.toBuffer())).toBe(true);
    expect(data.subarray(afterCap + 33, afterCap + 65).equals(E.toBuffer()), 'financier').toBe(true);
    expect(data.length).toBe(afterCap + 65);
  });

  it('anonymous: parent slots are program-id sentinel (not writable/signer), Option<pubkey>=None', () => {
    const ix = buildCreateNodeInstruction({
      nodeId: NODE_ID,
      controller: A,
      payer: B,
      cap: CAP_NO_CEILING,
      financier: E,
    });
    // optional accounts present-as-sentinel: flags cleared vs the IDL delegate flags
    const accts = expectAccountFlags(ix, 'create_node', {
      3: { signer: false, writable: false },
      4: { signer: false, writable: false },
    });
    expect(ix.keys.length).toBe(accts.length);
    expect(ix.keys[3].pubkey.equals(DEXTER_VAULT_PROGRAM_ID)).toBe(true); // parent_node sentinel
    expect(ix.keys[4].pubkey.equals(DEXTER_VAULT_PROGRAM_ID)).toBe(true); // parent_controller sentinel
    const data = ix.data as Buffer;
    const afterCap = expectRateCap(data, 40, CAP_NO_CEILING);
    expect(data[afterCap], 'parent Option tag None').toBe(0);
    expect(data.subarray(afterCap + 1, afterCap + 33).equals(E.toBuffer()), 'financier').toBe(true);
    expect(data.length).toBe(afterCap + 33);
  });

  it('rejects a non-32-byte nodeId', () => {
    expect(() =>
      buildCreateNodeInstruction({ nodeId: new Uint8Array(31), controller: A, payer: B, cap: CAP_NO_CEILING, financier: E }),
    ).toThrow();
  });

  it('rejects a delegate missing the parentController', () => {
    expect(() =>
      buildCreateNodeInstruction({ nodeId: NODE_ID, controller: A, payer: B, cap: CAP_NO_CEILING, parentNode: C, financier: E }),
    ).toThrow();
  });
});

describe('attach_node builder ↔ IDL', () => {
  it('5 accounts incl event pair, two byte-vec args', () => {
    const clientDataJSON = new Uint8Array([1, 2, 3]);
    const authenticatorData = new Uint8Array([4, 5, 6, 7]);
    const ix = buildAttachNodeInstruction({ vaultPda: A, node: B, clientDataJSON, authenticatorData });
    const accts = expectAccountFlags(ix, 'attach_node');
    expect(ix.keys.length).toBe(accts.length);
    expect(ix.keys[0].pubkey.equals(A)).toBe(true); // vault (w)
    expect(ix.keys[1].pubkey.equals(B)).toBe(true); // node (ro)
    expect(ix.keys[2].pubkey.equals(INSTRUCTIONS_SYSVAR_ID)).toBe(true);
    expect(ix.keys[3].pubkey.equals(EVENT_AUTHORITY)).toBe(true);
    expect(ix.keys[4].pubkey.equals(DEXTER_VAULT_PROGRAM_ID)).toBe(true);
    // data: disc(8) || vec(3): len4+3 || vec(4): len4+4 = 8 + 7 + 8 = 23
    const data = ix.data as Buffer;
    expect(data.length).toBe(23);
    expect(data.readUInt32LE(8)).toBe(3);
    expect(Array.from(data.subarray(12, 15))).toEqual([1, 2, 3]);
    expect(data.readUInt32LE(15)).toBe(4);
    expect(Array.from(data.subarray(19, 23))).toEqual([4, 5, 6, 7]);
  });
});

describe('attach_root builder ↔ IDL', () => {
  it('5 accounts incl event pair, nullifier[32] arg', () => {
    const ix = buildAttachRootInstruction({ node: A, nodeController: B, creditRoot: C, nullifier: NULLIFIER });
    const accts = expectAccountFlags(ix, 'attach_root');
    expect(ix.keys.length).toBe(accts.length);
    expect(ix.keys[0].pubkey.equals(A)).toBe(true); // node (w)
    expect(ix.keys[1].pubkey.equals(B)).toBe(true); // node_controller (signer)
    expect(ix.keys[2].pubkey.equals(C)).toBe(true); // credit_root (ro)
    expect(ix.keys[3].pubkey.equals(EVENT_AUTHORITY)).toBe(true);
    expect(ix.keys[4].pubkey.equals(DEXTER_VAULT_PROGRAM_ID)).toBe(true);
    // data: disc(8) || nullifier(32) = 40
    const data = ix.data as Buffer;
    expect(data.length).toBe(40);
    expect(data.subarray(8, 40).equals(Buffer.from(NULLIFIER))).toBe(true);
  });
});

describe('emancipate builder ↔ IDL', () => {
  it('re-rooting: credit_root present, Option<[u8;32]>=Some', () => {
    const ix = buildEmancipateInstruction({
      node: A,
      parentNode: B,
      parentController: C,
      nodeController: D,
      creditRoot: E,
      newNullifier: NULLIFIER,
    });
    const accts = expectAccountFlags(ix, 'emancipate');
    expect(ix.keys.length).toBe(accts.length); // 8 incl event pair
    expect(ix.keys[0].pubkey.equals(A)).toBe(true);
    expect(ix.keys[1].pubkey.equals(B)).toBe(true);
    expect(ix.keys[2].pubkey.equals(C)).toBe(true);
    expect(ix.keys[3].pubkey.equals(D)).toBe(true);
    expect(ix.keys[4].pubkey.equals(E)).toBe(true); // credit_root present
    expect(ix.keys[5].pubkey.equals(GRAPH_CONFIG)).toBe(true);
    expect(ix.keys[6].pubkey.equals(EVENT_AUTHORITY)).toBe(true);
    expect(ix.keys[7].pubkey.equals(DEXTER_VAULT_PROGRAM_ID)).toBe(true);
    // data: disc(8) || Option Some(1) || [u8;32] = 41
    const data = ix.data as Buffer;
    expect(data.length).toBe(41);
    expect(data[8]).toBe(1);
    expect(data.subarray(9, 41).equals(Buffer.from(NULLIFIER))).toBe(true);
  });

  it('edge-cut only: credit_root is program-id sentinel, Option<[u8;32]>=None', () => {
    const ix = buildEmancipateInstruction({ node: A, parentNode: B, parentController: C, nodeController: D });
    expectAccountFlags(ix, 'emancipate'); // credit_root flags (ro/non-signer) are identical either way
    expect(ix.keys[4].pubkey.equals(DEXTER_VAULT_PROGRAM_ID)).toBe(true); // sentinel
    const data = ix.data as Buffer;
    expect(data.length).toBe(9);
    expect(data[8]).toBe(0);
  });
});

describe('set_freeze builder ↔ IDL', () => {
  it('6 accounts incl event pair, bool arg', () => {
    const ix = buildSetFreezeInstruction({ targetNode: A, ancestorNode: B, ancestorController: C, frozen: true });
    const accts = expectAccountFlags(ix, 'set_freeze');
    expect(ix.keys.length).toBe(accts.length);
    expect(ix.keys[0].pubkey.equals(A)).toBe(true);
    expect(ix.keys[1].pubkey.equals(B)).toBe(true);
    expect(ix.keys[2].pubkey.equals(C)).toBe(true);
    expect(ix.keys[3].pubkey.equals(GRAPH_CONFIG)).toBe(true);
    expect(ix.keys[4].pubkey.equals(EVENT_AUTHORITY)).toBe(true);
    expect(ix.keys[5].pubkey.equals(DEXTER_VAULT_PROGRAM_ID)).toBe(true);
    const data = ix.data as Buffer;
    expect(data.length).toBe(9);
    expect(data[8]).toBe(1);
    expect((buildSetFreezeInstruction({ targetNode: A, ancestorNode: B, ancestorController: C, frozen: false })
      .data as Buffer)[8]).toBe(0);
  });
});

describe('set_pause builder ↔ IDL', () => {
  it('2 accounts, NO event pair (not an emit_cpi! ix), bool+u8 args', () => {
    const ix = buildSetPauseInstruction({ authority: A, paused: true, reason: 42 });
    const accts = expectAccountFlags(ix, 'set_pause');
    expect(accts.length).toBe(2);
    expect(ix.keys.length).toBe(2); // explicitly NO event_authority/program pair
    // confirm the trailing pair is genuinely absent
    expect(ix.keys.some((k) => k.pubkey.equals(EVENT_AUTHORITY))).toBe(false);
    expect(ix.keys[0].pubkey.equals(GRAPH_CONFIG)).toBe(true);
    expect(ix.keys[1].pubkey.equals(A)).toBe(true);
    const data = ix.data as Buffer;
    expect(data.length).toBe(10);
    expect(data[8]).toBe(1); // paused
    expect(data[9]).toBe(42); // reason
  });

  it('defaults reason to 0', () => {
    const ix = buildSetPauseInstruction({ authority: A, paused: false });
    const data = ix.data as Buffer;
    expect(data[8]).toBe(0);
    expect(data[9]).toBe(0);
  });
});

describe('seize_ancestor builder ↔ IDL', () => {
  it('9 fixed accounts (incl event pair) + appended chain, u64 amount arg', () => {
    const ix = buildSeizeAncestorInstruction({
      ancestorSwig: A,
      ancestorNode: B,
      defaultedNode: C,
      dexterAuthority: D,
      amount: 7_777n,
      chain: [E, F],
    });
    const accts = expectAccountFlags(ix, 'seize_ancestor');
    expect(accts.length).toBe(9);
    expect(ix.keys.length).toBe(9 + 2); // 9 fixed + 2 chain
    expect(ix.keys[0].pubkey.equals(A)).toBe(true); // ancestor_swig
    expect(ix.keys[1].pubkey.equals(deriveSwigWalletAddress(A))).toBe(true); // wallet PDA
    expect(ix.keys[2].pubkey.equals(B)).toBe(true); // ancestor_node
    expect(ix.keys[3].pubkey.equals(C)).toBe(true); // defaulted_node (w)
    expect(ix.keys[4].pubkey.equals(GRAPH_CONFIG)).toBe(true);
    expect(ix.keys[5].pubkey.equals(D)).toBe(true); // dexter_authority (signer)
    expect(ix.keys[6].pubkey.equals(INSTRUCTIONS_SYSVAR_ID)).toBe(true);
    expect(ix.keys[7].pubkey.equals(EVENT_AUTHORITY)).toBe(true);
    expect(ix.keys[8].pubkey.equals(DEXTER_VAULT_PROGRAM_ID)).toBe(true);
    // chain appended writable, non-signer
    expect(ix.keys[9].pubkey.equals(E)).toBe(true);
    expect(ix.keys[9].isWritable).toBe(true);
    expect(ix.keys[9].isSigner).toBe(false);
    expect(ix.keys[10].pubkey.equals(F)).toBe(true);
    expect(ix.keys[10].isWritable).toBe(true);
    // data: disc(8) || amount u64(8) = 16
    const data = ix.data as Buffer;
    expect(data.length).toBe(16);
    expect(data.readBigUInt64LE(8)).toBe(7_777n);
  });

  it('omits the chain when none supplied (depth-1)', () => {
    const ix = buildSeizeAncestorInstruction({
      ancestorSwig: A,
      ancestorNode: B,
      defaultedNode: C,
      dexterAuthority: D,
      amount: 1n,
    });
    expect(ix.keys.length).toBe(9);
  });
});
