import { describe, it, expect } from 'vitest';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import {
  buildOpenStandbyInstruction,
  buildDrawCreditInstruction,
  buildRepayCreditInstruction,
  buildSeizeCollateralInstruction,
  buildMigrateV4ToV5Instruction,
  deriveStandbyBackerPda,
} from '../src/instructions/credit.js';
import { deriveSwigWalletAddress } from '../src/instructions/withdraw.js';
import { deriveGraphConfigPda, deriveEventAuthorityPda } from '../src/credit/derive.js';
import { DEXTER_VAULT_PROGRAM_ID, DISCRIMINATORS, INSTRUCTIONS_SYSVAR_ID } from '../src/constants/index.js';

const [GRAPH_CONFIG] = deriveGraphConfigPda();
const [EVENT_AUTHORITY] = deriveEventAuthorityPda();

// Distinct valid base58 pubkeys so positional assertions stay unambiguous.
const RENT = new PublicKey('SysvarRent111111111111111111111111111111111');
const CLOCK = new PublicKey('SysvarC1ock11111111111111111111111111111111');
const WSOL = new PublicKey('So11111111111111111111111111111111111111112');
const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const SYSTEM = new PublicKey('11111111111111111111111111111111');

describe('openStandby', () => {
  it('emits 4 accounts in canonical order with u64 cap + two byte-vec args', () => {
    const clientDataJSON = new Uint8Array([1, 2, 3]);
    const authenticatorData = new Uint8Array([4, 5, 6, 7]);
    const ix = buildOpenStandbyInstruction({
      vaultPda: RENT,
      financierSwig: CLOCK,
      cap: 5_000_000n,
      clientDataJSON,
      authenticatorData,
    });
    expect(ix.programId.equals(DEXTER_VAULT_PROGRAM_ID)).toBe(true);
    expect(ix.keys.length).toBe(4);
    // [0] vault (writable, not signer)
    expect(ix.keys[0].pubkey.equals(RENT)).toBe(true);
    expect(ix.keys[0].isWritable).toBe(true);
    expect(ix.keys[0].isSigner).toBe(false);
    // [1] financier_swig (readonly, not signer)
    expect(ix.keys[1].pubkey.equals(CLOCK)).toBe(true);
    expect(ix.keys[1].isWritable).toBe(false);
    expect(ix.keys[1].isSigner).toBe(false);
    // [2] standby_backer (writable, PDA derived from financier_swig)
    expect(ix.keys[2].pubkey.equals(deriveStandbyBackerPda(CLOCK))).toBe(true);
    expect(ix.keys[2].isWritable).toBe(true);
    expect(ix.keys[2].isSigner).toBe(false);
    // [3] instructions_sysvar (readonly)
    expect(ix.keys[3].pubkey.equals(INSTRUCTIONS_SYSVAR_ID)).toBe(true);
    expect(ix.keys[3].isWritable).toBe(false);
    expect(ix.keys[3].isSigner).toBe(false);
    // data: disc(8) + cap u64(8) + (len4+3) + (len4+4) = 8 + 8 + 7 + 8 = 31
    expect(ix.data.length).toBe(31);
    expect(Buffer.from(ix.data.subarray(0, 8))).toEqual(Buffer.from(DISCRIMINATORS.open_standby));
    // cap u64 at [8,16)
    expect(ix.data.readBigUInt64LE(8)).toBe(5_000_000n);
    // client_data_json vec: len prefix 3 at [16], then [1,2,3] at [20,23)
    expect(ix.data.readUInt32LE(16)).toBe(3);
    expect(Array.from(ix.data.subarray(20, 23))).toEqual([1, 2, 3]);
    // authenticator_data vec: len prefix 4 at [23], then [4,5,6,7] at [27,31)
    expect(ix.data.readUInt32LE(23)).toBe(4);
    expect(Array.from(ix.data.subarray(27, 31))).toEqual([4, 5, 6, 7]);
  });
});

// Distinct nodes for the graph layout assertions.
const DRAWING_NODE = new PublicKey('SysvarS1otHashes111111111111111111111111111');
const SELLER_DEST = new PublicKey('SysvarS1otHistory11111111111111111111111111');
const COLLATERAL = new PublicKey('SysvarStakeHistory1111111111111111111111111');
const ANC1 = new PublicKey('SysvarEpochSchedu1e111111111111111111111111');
const ANC2 = new PublicKey('SysvarRecentB1ockHashes11111111111111111111');

describe('drawCredit (depth-N graph)', () => {
  it('emits 10 fixed accounts + appended chain, with u64 amount + i64 recovery', () => {
    const ix = buildDrawCreditInstruction({
      financierSwig: RENT,
      vaultPda: CLOCK,
      drawingNode: DRAWING_NODE,
      sellerDestination: SELLER_DEST,
      dexterAuthority: WSOL,
      amount: 2_500_000n,
      recoveryWindowSeconds: 86_400n,
      chain: [ANC1, ANC2],
    });
    expect(ix.programId.equals(DEXTER_VAULT_PROGRAM_ID)).toBe(true);
    expect(ix.keys.length).toBe(12); // 10 fixed + 2 chain
    expect(ix.keys[0].pubkey.equals(RENT)).toBe(true);                              // financier_swig (ro)
    expect(ix.keys[0].isWritable).toBe(false);
    expect(ix.keys[1].pubkey.equals(deriveSwigWalletAddress(RENT))).toBe(true);     // financier_swig_wallet (ro)
    expect(ix.keys[2].pubkey.equals(CLOCK)).toBe(true);                             // vault — now READONLY
    expect(ix.keys[2].isWritable).toBe(false);
    expect(ix.keys[3].pubkey.equals(DRAWING_NODE)).toBe(true);                      // drawing_node (w)
    expect(ix.keys[3].isWritable).toBe(true);
    expect(ix.keys[4].pubkey.equals(GRAPH_CONFIG)).toBe(true);                      // graph_config
    expect(ix.keys[5].pubkey.equals(SELLER_DEST)).toBe(true);                       // seller_destination
    expect(ix.keys[6].pubkey.equals(WSOL)).toBe(true);                             // dexter_authority (signer)
    expect(ix.keys[6].isSigner).toBe(true);
    expect(ix.keys[7].pubkey.equals(INSTRUCTIONS_SYSVAR_ID)).toBe(true);            // instructions_sysvar
    expect(ix.keys[8].pubkey.equals(EVENT_AUTHORITY)).toBe(true);                   // event_authority
    expect(ix.keys[9].pubkey.equals(DEXTER_VAULT_PROGRAM_ID)).toBe(true);           // program
    // chain appended writable, non-signer, in child→parent order
    expect(ix.keys[10].pubkey.equals(ANC1)).toBe(true);
    expect(ix.keys[10].isWritable).toBe(true);
    expect(ix.keys[10].isSigner).toBe(false);
    expect(ix.keys[11].pubkey.equals(ANC2)).toBe(true);
    // data: disc(8) + amount u64(8) + recovery i64(8) = 24
    expect(ix.data.length).toBe(24);
    expect(Buffer.from(ix.data.subarray(0, 8))).toEqual(Buffer.from(DISCRIMINATORS.draw_credit));
    expect(ix.data.readBigUInt64LE(8)).toBe(2_500_000n);
    expect(ix.data.readBigInt64LE(16)).toBe(86_400n);
  });

  it('omits the chain for a depth-1 rooted leaf', () => {
    const ix = buildDrawCreditInstruction({
      financierSwig: RENT, vaultPda: CLOCK, drawingNode: DRAWING_NODE,
      sellerDestination: SELLER_DEST, dexterAuthority: WSOL,
      amount: 1n, recoveryWindowSeconds: 0n,
    });
    expect(ix.keys.length).toBe(10);
  });
});

describe('repayCredit (depth-N graph)', () => {
  it('emits 9 fixed accounts + appended chain with a single u64 amount arg', () => {
    const ix = buildRepayCreditInstruction({
      swigAddress: RENT,
      vaultPda: CLOCK,
      drawingNode: DRAWING_NODE,
      dexterAuthority: WSOL,
      amount: 1_000_000n,
      chain: [ANC1],
    });
    expect(ix.keys.length).toBe(10); // 9 fixed + 1 chain
    expect(ix.keys[0].pubkey.equals(RENT)).toBe(true);                          // swig (ro)
    expect(ix.keys[1].pubkey.equals(deriveSwigWalletAddress(RENT))).toBe(true); // swig_wallet (ro)
    expect(ix.keys[2].pubkey.equals(CLOCK)).toBe(true);                         // vault (ro)
    expect(ix.keys[2].isWritable).toBe(false);
    expect(ix.keys[3].pubkey.equals(DRAWING_NODE)).toBe(true);                  // drawing_node (w)
    expect(ix.keys[3].isWritable).toBe(true);
    expect(ix.keys[4].pubkey.equals(GRAPH_CONFIG)).toBe(true);                  // graph_config
    expect(ix.keys[5].pubkey.equals(WSOL)).toBe(true);                         // dexter_authority (signer)
    expect(ix.keys[5].isSigner).toBe(true);
    expect(ix.keys[6].pubkey.equals(INSTRUCTIONS_SYSVAR_ID)).toBe(true);        // instructions_sysvar
    expect(ix.keys[7].pubkey.equals(EVENT_AUTHORITY)).toBe(true);               // event_authority
    expect(ix.keys[8].pubkey.equals(DEXTER_VAULT_PROGRAM_ID)).toBe(true);       // program
    expect(ix.keys[9].pubkey.equals(ANC1)).toBe(true);                         // chain
    expect(ix.keys[9].isWritable).toBe(true);
    expect(ix.data.length).toBe(16);
    expect(Buffer.from(ix.data.subarray(0, 8))).toEqual(Buffer.from(DISCRIMINATORS.repay_credit));
    expect(ix.data.readBigUInt64LE(8)).toBe(1_000_000n);
  });
});

describe('seizeCollateral (depth-N graph)', () => {
  it('emits 10 fixed accounts + appended chain, empty args (discriminator only)', () => {
    const ix = buildSeizeCollateralInstruction({
      swigAddress: RENT,
      vaultPda: CLOCK,
      drawingNode: DRAWING_NODE,
      collateralAta: COLLATERAL,
      dexterAuthority: WSOL,
      chain: [ANC1, ANC2],
    });
    expect(ix.keys.length).toBe(12); // 10 fixed + 2 chain
    expect(ix.keys[0].pubkey.equals(RENT)).toBe(true);                          // swig
    expect(ix.keys[1].pubkey.equals(deriveSwigWalletAddress(RENT))).toBe(true); // swig_wallet
    expect(ix.keys[2].pubkey.equals(CLOCK)).toBe(true);                         // vault (ro)
    expect(ix.keys[2].isWritable).toBe(false);
    expect(ix.keys[3].pubkey.equals(DRAWING_NODE)).toBe(true);                  // drawing_node (w)
    expect(ix.keys[3].isWritable).toBe(true);
    expect(ix.keys[4].pubkey.equals(COLLATERAL)).toBe(true);                    // collateral_ata
    expect(ix.keys[5].pubkey.equals(GRAPH_CONFIG)).toBe(true);                  // graph_config
    expect(ix.keys[6].pubkey.equals(WSOL)).toBe(true);                         // dexter_authority (signer)
    expect(ix.keys[6].isSigner).toBe(true);
    expect(ix.keys[7].pubkey.equals(INSTRUCTIONS_SYSVAR_ID)).toBe(true);        // instructions_sysvar
    expect(ix.keys[8].pubkey.equals(EVENT_AUTHORITY)).toBe(true);               // event_authority
    expect(ix.keys[9].pubkey.equals(DEXTER_VAULT_PROGRAM_ID)).toBe(true);       // program
    expect(ix.keys[10].pubkey.equals(ANC1)).toBe(true);
    expect(ix.keys[11].pubkey.equals(ANC2)).toBe(true);
    expect(ix.data.length).toBe(8);
    expect(Buffer.from(ix.data)).toEqual(Buffer.from(DISCRIMINATORS.seize_collateral));
  });
});

describe('migrateV4ToV5', () => {
  it('emits 4 accounts in canonical order, empty args (discriminator only)', () => {
    const ix = buildMigrateV4ToV5Instruction({
      vaultPda: RENT,
      dexterAuthority: CLOCK,
      payer: WSOL,
    });
    expect(ix.programId.equals(DEXTER_VAULT_PROGRAM_ID)).toBe(true);
    expect(ix.keys.length).toBe(4);
    // [0] vault (writable, not signer)
    expect(ix.keys[0].pubkey.equals(RENT)).toBe(true);
    expect(ix.keys[0].isWritable).toBe(true);
    expect(ix.keys[0].isSigner).toBe(false);
    // [1] dexter_authority (signer, not writable)
    expect(ix.keys[1].pubkey.equals(CLOCK)).toBe(true);
    expect(ix.keys[1].isSigner).toBe(true);
    expect(ix.keys[1].isWritable).toBe(false);
    // [2] payer (signer, writable)
    expect(ix.keys[2].pubkey.equals(WSOL)).toBe(true);
    expect(ix.keys[2].isSigner).toBe(true);
    expect(ix.keys[2].isWritable).toBe(true);
    // [3] system_program (readonly)
    expect(ix.keys[3].pubkey.equals(SystemProgram.programId)).toBe(true);
    expect(ix.keys[3].isWritable).toBe(false);
    expect(ix.keys[3].isSigner).toBe(false);
    // data: disc(8) only
    expect(ix.data.length).toBe(8);
    expect(Buffer.from(ix.data)).toEqual(Buffer.from(DISCRIMINATORS.migrate_v4_to_v5));
  });
});
