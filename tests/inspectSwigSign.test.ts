import { describe, test, expect } from 'vitest';
import {
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  inspectSwigSignInstructions,
  isMasterSignSafe,
  inspectSwigInstructions,
  isSwigCoSignSafe,
} from '../src/instructions/index.js';
import { SWIG_PROGRAM_ID, USDC_MAINNET } from '../src/constants/index.js';

// swig SignV1 = 4, SignV2 = 11 (u16 LE @0). Both share the SignV2Args header
// { u16 instruction, u16 payload_len, u32 role_id } → role_id u32 LE @4.
// Source: swig program instruction.rs / sign_v2.rs @ rev c2e8eb4.
function swigSignData(disc: number, roleId: number, payloadLen = 0): Buffer {
  const buf = Buffer.alloc(8 + payloadLen);
  buf.writeUInt16LE(disc, 0);
  buf.writeUInt16LE(payloadLen, 2);
  buf.writeUInt32LE(roleId, 4);
  return buf;
}

const DUMMY_PAYER = new PublicKey(USDC_MAINNET); // any valid pubkey; compile only
const DUMMY_BLOCKHASH = '11111111111111111111111111111111'; // 32-byte base58, valid for compile

function v0TxFrom(instructions: TransactionInstruction[]): VersionedTransaction {
  const msg = new TransactionMessage({
    payerKey: DUMMY_PAYER,
    recentBlockhash: DUMMY_BLOCKHASH,
    instructions,
  }).compileToV0Message();
  return new VersionedTransaction(msg);
}

function swigSignIx(disc: number, roleId: number): TransactionInstruction {
  return new TransactionInstruction({
    programId: SWIG_PROGRAM_ID,
    keys: [],
    data: swigSignData(disc, roleId),
  });
}

// A non-swig instruction (e.g. a vault-program ix like initialize_vault) — must
// be invisible to the swig-sign inspector.
function nonSwigIx(): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey('Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc'),
    keys: [],
    data: Buffer.from([1, 2, 3, 4]),
  });
}

describe('inspectSwigSignInstructions (master-signer bypass gate)', () => {
  test('detects a SignV2 role_id (the open-ended role-2 spend)', () => {
    const tx = v0TxFrom([swigSignIx(11, 2)]);
    expect(inspectSwigSignInstructions(tx)).toEqual({ signV2RoleIds: [2], signV1RoleIds: [] });
  });

  test('detects a SignV2 role-3 (the scoped tab settle)', () => {
    const tx = v0TxFrom([swigSignIx(11, 3)]);
    expect(inspectSwigSignInstructions(tx)).toEqual({ signV2RoleIds: [3], signV1RoleIds: [] });
  });

  test('detects a legacy SignV1 separately', () => {
    const tx = v0TxFrom([swigSignIx(4, 3)]);
    expect(inspectSwigSignInstructions(tx)).toEqual({ signV2RoleIds: [], signV1RoleIds: [3] });
  });

  test('ignores non-swig instructions (e.g. initialize_vault)', () => {
    const tx = v0TxFrom([nonSwigIx()]);
    expect(inspectSwigSignInstructions(tx)).toEqual({ signV2RoleIds: [], signV1RoleIds: [] });
  });

  test('collects every swig sign role_id in instruction order', () => {
    const tx = v0TxFrom([nonSwigIx(), swigSignIx(11, 3), swigSignIx(11, 2)]);
    expect(inspectSwigSignInstructions(tx)).toEqual({ signV2RoleIds: [3, 2], signV1RoleIds: [] });
  });
});

describe('isMasterSignSafe (default-deny role policy)', () => {
  test('allows a tx with no swig sign at all (initialize_vault path)', () => {
    expect(isMasterSignSafe(v0TxFrom([nonSwigIx()]), [3])).toBe(true);
  });

  test('allows a role-3 SignV2 (tab settle is master-signable)', () => {
    expect(isMasterSignSafe(v0TxFrom([swigSignIx(11, 3)]), [3])).toBe(true);
  });

  test('REFUSES a role-2 SignV2 (the open-ended spend bypass)', () => {
    expect(isMasterSignSafe(v0TxFrom([swigSignIx(11, 2)]), [3])).toBe(false);
  });

  test('REFUSES a legacy SignV1 regardless of role (default-deny on V1)', () => {
    expect(isMasterSignSafe(v0TxFrom([swigSignIx(4, 3)]), [3])).toBe(false);
  });

  test('REFUSES a mixed tx hiding a role-2 spend behind a legit role-3', () => {
    expect(isMasterSignSafe(v0TxFrom([swigSignIx(11, 3), swigSignIx(11, 2)]), [3])).toBe(false);
  });

  test('empty allowlist refuses every swig sign', () => {
    expect(isMasterSignSafe(v0TxFrom([swigSignIx(11, 3)]), [])).toBe(false);
  });
});

// A bare swig instruction by discriminator (non-Sign ops carry no role_id).
// SwigInstruction enum @ c2e8eb4: CreateV1=0, AddAuthorityV1=1, RemoveAuthorityV1=2,
// UpdateAuthorityV1=3, SignV1=4, CreateSessionV1=5, SignV2=11.
function swigIx(disc: number): TransactionInstruction {
  const buf = Buffer.alloc(8);
  buf.writeUInt16LE(disc, 0);
  return new TransactionInstruction({ programId: SWIG_PROGRAM_ID, keys: [], data: buf });
}

describe('inspectSwigInstructions (full swig-instruction classifier)', () => {
  test('reports discriminator for every swig ix; role_id only for Sign variants', () => {
    const tx = v0TxFrom([swigIx(0), swigIx(1), swigSignIx(11, 3), swigSignIx(4, 2), nonSwigIx()]);
    expect(inspectSwigInstructions(tx)).toEqual([
      { discriminator: 0 }, // CreateV1 — no role_id
      { discriminator: 1 }, // AddAuthorityV1 — no role_id
      { discriminator: 11, roleId: 3 }, // SignV2 role 3
      { discriminator: 4, roleId: 2 }, // SignV1 role 2
    ]); // nonSwigIx ignored
  });
});

describe('isSwigCoSignSafe (fee-payer co-sign allowlist — gates EVERY /sign-transaction call)', () => {
  const OPTS = { allowedSignV2Roles: [3], allowCreate: true };

  test('allows the tab settle (SignV2 role 3)', () => {
    expect(isSwigCoSignSafe(v0TxFrom([swigSignIx(11, 3)]), OPTS)).toBe(true);
  });

  test('allows vault creation (CreateV1) when allowCreate', () => {
    expect(isSwigCoSignSafe(v0TxFrom([swigIx(0)]), OPTS)).toBe(true);
  });

  test('allows a tx with no swig ix at all', () => {
    expect(isSwigCoSignSafe(v0TxFrom([nonSwigIx()]), OPTS)).toBe(true);
  });

  test('REFUSES AddAuthorityV1 (the uncapped-role-grant escalation)', () => {
    expect(isSwigCoSignSafe(v0TxFrom([swigIx(1)]), OPTS)).toBe(false);
  });

  test('REFUSES RemoveAuthorityV1', () => {
    expect(isSwigCoSignSafe(v0TxFrom([swigIx(2)]), OPTS)).toBe(false);
  });

  test('REFUSES CreateSessionV1 (arming a new session off-path)', () => {
    expect(isSwigCoSignSafe(v0TxFrom([swigIx(5)]), OPTS)).toBe(false);
  });

  test('REFUSES the role-2 spend (SignV2 role 2)', () => {
    expect(isSwigCoSignSafe(v0TxFrom([swigSignIx(11, 2)]), OPTS)).toBe(false);
  });

  test('REFUSES any SignV1', () => {
    expect(isSwigCoSignSafe(v0TxFrom([swigSignIx(4, 3)]), OPTS)).toBe(false);
  });

  test('REFUSES CreateV1 when allowCreate is false', () => {
    expect(isSwigCoSignSafe(v0TxFrom([swigIx(0)]), { allowedSignV2Roles: [3], allowCreate: false })).toBe(false);
  });

  test('REFUSES a mixed tx smuggling AddAuthority behind a legit CreateV1', () => {
    expect(isSwigCoSignSafe(v0TxFrom([swigIx(0), swigIx(1)]), OPTS)).toBe(false);
  });
});
