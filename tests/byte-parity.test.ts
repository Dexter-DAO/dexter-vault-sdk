import { describe, test, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { DISCRIMINATORS, OTS_SESSION_REGISTER_V1_DOMAIN, OTS_SESSION_REGISTER_V2_DOMAIN, OTS_SESSION_REVOKE_V1_DOMAIN, OTS_REVOKE_AGENT_SPEND_V1_DOMAIN, OTS_ENABLE_AGENT_SPEND_V1_DOMAIN } from '../src/constants/index.js';
import { sessionRegisterMessage, sessionRevokeMessage, revokeAgentSpendMessage, enableAgentSpendMessage, voucherPayloadMessage, buildVoucherMessage, buildSetSwigOperationMessage } from '../src/messages/index.js';
import { buildSettleTabVoucherInstruction, buildInitializeVaultInstruction, buildSetSwigInstruction, buildSetSwigAtomicInstruction, SET_SWIG_ATOMIC_DISCRIMINATOR, buildRegisterSessionKeyInstruction, buildRevokeSessionKeyInstruction, buildProvePasskeyInstruction, buildRequestWithdrawalInstruction, buildFinalizeWithdrawalInstruction, buildForceReleaseInstruction, buildRotatePasskeyInstruction, buildRotateDexterAuthorityInstruction, buildSettleVoucherInstruction } from '../src/instructions/index.js';

// ── Known-good test inputs (all-zero / sequential bytes so snapshots are stable) ──

const KNOWN_PROGRAM_ID = new PublicKey('Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc');
const KNOWN_VAULT_PDA  = new PublicKey('Sysvar1nstructions1111111111111111111111111');
const KNOWN_SESSION_PUBKEY    = new Uint8Array(32).fill(0xAA);
const KNOWN_COUNTERPARTY      = new PublicKey('Ed25519SigVerify111111111111111111111111111');
const KNOWN_CHANNEL_ID        = new Uint8Array(32).fill(0xBB);
const KNOWN_PASSKEY_PUBKEY    = new Uint8Array(33).fill(0xCC);
const KNOWN_IDENTITY_CLAIM    = new Uint8Array(32).fill(0xDD);
const KNOWN_CLIENT_DATA       = new Uint8Array([1, 2, 3, 4]);
const KNOWN_AUTH_DATA         = new Uint8Array([5, 6, 7, 8]);
const KNOWN_NEW_PASSKEY       = new Uint8Array(33).fill(0xEE);
const KNOWN_DESTINATION       = new PublicKey('Secp256r1SigVerify1111111111111111111111111');
const KNOWN_VAULT_USDC_ATA    = new PublicKey('So11111111111111111111111111111111111111112');

// ── Discriminators (the "Role not found for ID: 3" preventer) ──

describe('discriminators (8 bytes, locked)', () => {
  test('settle_tab_voucher', () => {
    expect(DISCRIMINATORS.settle_tab_voucher).toEqual(
      Uint8Array.from([173, 22, 98, 31, 110, 129, 59, 161]),
    );
  });
  test('register_session_key', () => {
    expect(DISCRIMINATORS.register_session_key).toEqual(
      Uint8Array.from([69, 94, 60, 44, 49, 199, 183, 233]),
    );
  });
  test('revoke_session_key', () => {
    expect(DISCRIMINATORS.revoke_session_key).toEqual(
      Uint8Array.from([81, 192, 32, 110, 104, 116, 144, 151]),
    );
  });
  test('initialize_vault', () => {
    expect(DISCRIMINATORS.initialize_vault).toEqual(
      Uint8Array.from([48, 191, 163, 44, 71, 129, 63, 164]),
    );
  });
  test('set_swig', () => {
    expect(DISCRIMINATORS.set_swig).toEqual(
      Uint8Array.from([253, 229, 89, 206, 192, 118, 137, 165]),
    );
  });
  test('settle_voucher', () => {
    expect(DISCRIMINATORS.settle_voucher).toEqual(
      Uint8Array.from([144, 176, 128, 220, 156, 79, 41, 54]),
    );
  });
  test('request_withdrawal', () => {
    expect(DISCRIMINATORS.request_withdrawal).toEqual(
      Uint8Array.from([251, 85, 121, 205, 56, 201, 12, 177]),
    );
  });
  test('finalize_withdrawal', () => {
    expect(DISCRIMINATORS.finalize_withdrawal).toEqual(
      Uint8Array.from([178, 87, 206, 68, 201, 186, 164, 232]),
    );
  });
  test('force_release', () => {
    expect(DISCRIMINATORS.force_release).toEqual(
      Uint8Array.from([122, 190, 243, 252, 54, 202, 208, 234]),
    );
  });
  test('rotate_passkey', () => {
    expect(DISCRIMINATORS.rotate_passkey).toEqual(
      Uint8Array.from([28, 134, 49, 89, 196, 34, 58, 174]),
    );
  });
  test('rotate_dexter_authority', () => {
    expect(DISCRIMINATORS.rotate_dexter_authority).toEqual(
      Uint8Array.from([145, 60, 4, 119, 180, 205, 236, 134]),
    );
  });
  test('prove_passkey', () => {
    expect(DISCRIMINATORS.prove_passkey).toEqual(
      Uint8Array.from([35, 175, 41, 143, 201, 118, 49, 184]),
    );
  });
  test('lock_voucher', () => {
    expect(DISCRIMINATORS.lock_voucher).toEqual(
      Uint8Array.from([91, 138, 5, 227, 119, 239, 48, 254]),
    );
  });
  test('settle_locked_voucher', () => {
    expect(DISCRIMINATORS.settle_locked_voucher).toEqual(
      Uint8Array.from([44, 80, 216, 43, 247, 253, 101, 45]),
    );
  });
  test('transfer_lock_ownership', () => {
    expect(DISCRIMINATORS.transfer_lock_ownership).toEqual(
      Uint8Array.from([193, 13, 131, 134, 95, 25, 229, 157]),
    );
  });
  test('recover_abandoned_lock', () => {
    expect(DISCRIMINATORS.recover_abandoned_lock).toEqual(
      Uint8Array.from([169, 213, 107, 64, 229, 49, 43, 234]),
    );
  });
});

// ── REAL parity: derive each discriminator from the Anchor formula, not a copy ──
//
// The block above pins constants against hand-copied literals — that catches an
// ACCIDENTAL CHANGE, but it does NOT verify the values are actually correct: a
// typo copied into both the constant and its literal passes green. An Anchor
// instruction discriminator is sha256("global:<ix_name>")[..8]. We compute that
// here INDEPENDENTLY and assert every shipped DISCRIMINATOR matches the derived
// value. This is the load-bearing guarantee the package sells; it must verify
// against the formula the chain uses, not against a snapshot of itself.
describe('discriminators — derived parity (sha256("global:<name>")[..8])', () => {
  function derive(ixName: string): Uint8Array {
    return Uint8Array.from(
      createHash('sha256').update(`global:${ixName}`).digest().subarray(0, 8),
    );
  }

  // Every key in DISCRIMINATORS is the snake_case on-chain instruction name, so
  // we can derive directly from the key. This also auto-covers any future
  // instruction added to the map — no new test needed.
  for (const name of Object.keys(DISCRIMINATORS)) {
    test(`${name} matches the Anchor formula`, () => {
      const shipped = (DISCRIMINATORS as Record<string, Uint8Array>)[name];
      expect(shipped).toEqual(derive(name));
    });
  }

  // Guard against the formula itself silently no-op'ing: prove derive() actually
  // discriminates (a wrong name must NOT match a real discriminator).
  test('a wrong instruction name does NOT match (the test can fail)', () => {
    expect(DISCRIMINATORS.settle_tab_voucher).not.toEqual(derive('not_a_real_instruction'));
  });
});

// ── Domain separators (32 bytes, NUL-padded) ──

describe('domain separators', () => {
  test('OTS_SESSION_REGISTER_V1', () => {
    expect(OTS_SESSION_REGISTER_V1_DOMAIN.length).toBe(32);
    expect(OTS_SESSION_REGISTER_V1_DOMAIN).toMatchSnapshot();
  });
  test('OTS_SESSION_REVOKE_V1', () => {
    expect(OTS_SESSION_REVOKE_V1_DOMAIN.length).toBe(32);
    expect(OTS_SESSION_REVOKE_V1_DOMAIN).toMatchSnapshot();
  });
  test('OTS_SESSION_REGISTER_V2 is 32 bytes, 23-char label + 9 NUL', () => {
    expect(OTS_SESSION_REGISTER_V2_DOMAIN.length).toBe(32);
    // "OTS_SESSION_REGISTER_V2" is 23 chars
    const label = new TextDecoder().decode(OTS_SESSION_REGISTER_V2_DOMAIN.slice(0, 23));
    expect(label).toBe('OTS_SESSION_REGISTER_V2');
    for (let i = 23; i < 32; i++) {
      expect(OTS_SESSION_REGISTER_V2_DOMAIN[i]).toBe(0);
    }
  });
});

// ── Message layouts ──

describe('message layouts', () => {
  test('188-byte V2 session registration', () => {
    const bytes = sessionRegisterMessage({
      programId: KNOWN_PROGRAM_ID,
      vaultPda: KNOWN_VAULT_PDA,
      sessionPubkey: KNOWN_SESSION_PUBKEY,
      maxAmount: 1_000_000n,
      expiresAt: 1735689600n,
      allowedCounterparty: KNOWN_COUNTERPARTY,
      nonce: 42,
      maxRevolvingCapacity: 2_000_000n,
    });
    expect(bytes.length).toBe(188);
    expect(bytes.subarray(0, 32)).toEqual(OTS_SESSION_REGISTER_V2_DOMAIN);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getBigUint64(180, true)).toBe(2_000_000n);
    expect(bytes).toMatchSnapshot();
  });

  test('128-byte session revocation', () => {
    const bytes = sessionRevokeMessage({
      programId: KNOWN_PROGRAM_ID,
      vaultPda: KNOWN_VAULT_PDA,
      sessionPubkey: KNOWN_SESSION_PUBKEY,
    });
    expect(bytes.length).toBe(128);
    expect(bytes.subarray(0, 32)).toEqual(OTS_SESSION_REVOKE_V1_DOMAIN);
    expect(bytes).toMatchSnapshot();
  });

  test('44-byte voucher (named-arg form)', () => {
    const bytes = voucherPayloadMessage({
      channelId: KNOWN_CHANNEL_ID,
      cumulativeAmount: 12_345n,
      sequenceNumber: 7,
    });
    expect(bytes.length).toBe(44);
    expect(bytes).toMatchSnapshot();
  });

  test('44-byte voucher (positional form yields identical bytes)', () => {
    const a = voucherPayloadMessage({ channelId: KNOWN_CHANNEL_ID, cumulativeAmount: 12_345n, sequenceNumber: 7 });
    const b = buildVoucherMessage(KNOWN_CHANNEL_ID, 12_345n, 7);
    expect(Buffer.from(b)).toEqual(Buffer.from(a));
  });

  test('set_swig operation message', () => {
    const bytes = buildSetSwigOperationMessage('Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc');
    expect(bytes.length).toBe(8 + 32);
    expect(bytes.subarray(0, 8)).toEqual(new TextEncoder().encode('set_swig'));
    expect(bytes).toMatchSnapshot();
  });
});

// ── Agent-spend off/on switch messages (anon-pay heal §5; AUTOMATIC mode) ──
// revoke = idempotent off-switch (no nonce); enable = replay-protected on-switch
// (server-issued single-use nonce + expiry). Both backend-verified, TS-only, no
// Rust. Layout mirrors sessionRevokeMessage: 32-byte NUL-padded domain + 32-byte
// pubkey identity fields, scalars packed at natural LE width (NOT padded to 32).

describe('agent-spend off/on messages (anon-pay heal §5)', () => {
  const KNOWN_NONCE  = 0x0123456789abcdefn;
  const KNOWN_EXPIRY = 1735689600n; // 2025-01-01T00:00:00Z

  test('OTS_REVOKE_AGENT_SPEND_V1 domain: 32 bytes, 25-char label + 7 NUL', () => {
    expect(OTS_REVOKE_AGENT_SPEND_V1_DOMAIN.length).toBe(32);
    const label = new TextDecoder().decode(OTS_REVOKE_AGENT_SPEND_V1_DOMAIN.slice(0, 25));
    expect(label).toBe('OTS_REVOKE_AGENT_SPEND_V1');
    for (let i = 25; i < 32; i++) expect(OTS_REVOKE_AGENT_SPEND_V1_DOMAIN[i]).toBe(0);
  });

  test('OTS_ENABLE_AGENT_SPEND_V1 domain: 32 bytes, 25-char label + 7 NUL', () => {
    expect(OTS_ENABLE_AGENT_SPEND_V1_DOMAIN.length).toBe(32);
    const label = new TextDecoder().decode(OTS_ENABLE_AGENT_SPEND_V1_DOMAIN.slice(0, 25));
    expect(label).toBe('OTS_ENABLE_AGENT_SPEND_V1');
    for (let i = 25; i < 32; i++) expect(OTS_ENABLE_AGENT_SPEND_V1_DOMAIN[i]).toBe(0);
  });

  test('off and on domains are distinct (no cross-replay between switch directions)', () => {
    expect(Buffer.from(OTS_REVOKE_AGENT_SPEND_V1_DOMAIN))
      .not.toEqual(Buffer.from(OTS_ENABLE_AGENT_SPEND_V1_DOMAIN));
  });

  test('96-byte revokeAgentSpendMessage (idempotent off-switch)', () => {
    const bytes = revokeAgentSpendMessage({
      programId: KNOWN_PROGRAM_ID,
      vaultPda: KNOWN_VAULT_PDA,
    });
    expect(bytes.length).toBe(96);
    expect(bytes.subarray(0, 32)).toEqual(OTS_REVOKE_AGENT_SPEND_V1_DOMAIN);
    expect(bytes.subarray(32, 64)).toEqual(KNOWN_PROGRAM_ID.toBytes());
    expect(bytes.subarray(64, 96)).toEqual(KNOWN_VAULT_PDA.toBytes());
    expect(bytes).toMatchSnapshot();
  });

  test('revokeAgentSpendMessage is deterministic (idempotent → replay-safe)', () => {
    const a = revokeAgentSpendMessage({ programId: KNOWN_PROGRAM_ID, vaultPda: KNOWN_VAULT_PDA });
    const b = revokeAgentSpendMessage({ programId: KNOWN_PROGRAM_ID, vaultPda: KNOWN_VAULT_PDA });
    expect(Buffer.from(b)).toEqual(Buffer.from(a));
  });

  test('112-byte enableAgentSpendMessage (replay-protected on-switch)', () => {
    const bytes = enableAgentSpendMessage({
      programId: KNOWN_PROGRAM_ID,
      vaultPda: KNOWN_VAULT_PDA,
      nonce: KNOWN_NONCE,
      expiry: KNOWN_EXPIRY,
    });
    expect(bytes.length).toBe(112);
    expect(bytes.subarray(0, 32)).toEqual(OTS_ENABLE_AGENT_SPEND_V1_DOMAIN);
    expect(bytes.subarray(32, 64)).toEqual(KNOWN_PROGRAM_ID.toBytes());
    expect(bytes.subarray(64, 96)).toEqual(KNOWN_VAULT_PDA.toBytes());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getBigUint64(96, true)).toBe(KNOWN_NONCE);   // u64 LE, packed (NOT padded to 32)
    expect(view.getBigInt64(104, true)).toBe(KNOWN_EXPIRY);  // i64 LE, packed
    expect(bytes).toMatchSnapshot();
  });

  test('enableAgentSpendMessage nonce binds the signature (different nonce → different bytes)', () => {
    const a = enableAgentSpendMessage({ programId: KNOWN_PROGRAM_ID, vaultPda: KNOWN_VAULT_PDA, nonce: 1n, expiry: KNOWN_EXPIRY });
    const b = enableAgentSpendMessage({ programId: KNOWN_PROGRAM_ID, vaultPda: KNOWN_VAULT_PDA, nonce: 2n, expiry: KNOWN_EXPIRY });
    expect(Buffer.from(b)).not.toEqual(Buffer.from(a));
  });
});

// ── Instruction data byte snapshots (the dirty-the-bytes lock) ──

describe('instruction data layouts', () => {
  test('initialize_vault', () => {
    const ix = buildInitializeVaultInstruction({
      vaultPda: KNOWN_VAULT_PDA,
      payer: KNOWN_COUNTERPARTY,
      dexterAuthority: KNOWN_COUNTERPARTY,
      passkeyPubkey: KNOWN_PASSKEY_PUBKEY,
      coolingOffSeconds: 0,
      identityClaim: KNOWN_IDENTITY_CLAIM,
    });
    expect(ix.programId).toEqual(KNOWN_PROGRAM_ID);
    expect(new Uint8Array(ix.data)).toMatchSnapshot('initialize_vault data');
    expect(ix.keys.map(k => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable }))).toMatchSnapshot('initialize_vault keys');
  });

  test('set_swig', () => {
    const ix = buildSetSwigInstruction({
      vaultPda: KNOWN_VAULT_PDA,
      swigAddress: KNOWN_VAULT_PDA,
      clientDataJSON: KNOWN_CLIENT_DATA,
      authenticatorData: KNOWN_AUTH_DATA,
    });
    expect(new Uint8Array(ix.data)).toMatchSnapshot('set_swig data');
    expect(ix.keys.map(k => k.pubkey.toBase58())).toMatchSnapshot('set_swig keys');
  });

  test('register_session_key (V2 — carries max_revolving_capacity)', async () => {
    const ix = buildRegisterSessionKeyInstruction({
      vaultPda: KNOWN_VAULT_PDA,
      sessionPubkey: KNOWN_SESSION_PUBKEY,
      maxAmount: 1_000_000n,
      expiresAt: 1735689600n,
      allowedCounterparty: KNOWN_COUNTERPARTY,
      nonce: 42,
      maxRevolvingCapacity: 2_000_000n,
      swigAddress: KNOWN_VAULT_PDA,
      vaultUsdcAta: KNOWN_VAULT_USDC_ATA,
      payer: KNOWN_DESTINATION,
      siblingSessionPdas: [],
      clientDataJSON: KNOWN_CLIENT_DATA,
      authenticatorData: KNOWN_AUTH_DATA,
    });
    // Borsh arg order: disc(8) + session_pubkey(32) + max_amount(8) + expires_at(8)
    //   + allowed_counterparty(32) + nonce(4) + max_revolving_capacity(8) + vecs...
    // max_revolving_capacity sits at offset 8+32+8+8+32+4 = 92, u64 LE.
    // DATA is UNCHANGED by the account growth — only the keys array grows.
    const data = new Uint8Array(ix.data);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    expect(view.getBigUint64(92, true)).toBe(2_000_000n);
    expect(data).toMatchSnapshot('register_session_key data');

    // ── V6 multi-session: 8-account layout (no siblings supplied here) ──
    //   [0] vault (writable)
    //   [1] vault_usdc_ata        (read)
    //   [2] swig                  (read)
    //   [3] swig_wallet_address   (derived, read)
    //   [4] instructions_sysvar   (read)
    //   [5] session PDA           (writable, init_if_needed)
    //   [6] payer                 (signer, writable)
    //   [7] system_program        (read)
    const { SWIG_PROGRAM_ID, INSTRUCTIONS_SYSVAR_ID } = await import('../src/constants/index.js');
    const { deriveSessionPda } = await import('../src/session/index.js');
    const { SystemProgram } = await import('@solana/web3.js');
    const [expectedSwigWalletAddress] = PublicKey.findProgramAddressSync(
      [Buffer.from('swig-wallet-address'), KNOWN_VAULT_PDA.toBytes()],
      SWIG_PROGRAM_ID,
    );
    const [expectedSessionPda] = deriveSessionPda(KNOWN_VAULT_PDA, KNOWN_COUNTERPARTY);

    expect(ix.keys).toHaveLength(8);
    expect(ix.keys[0]).toEqual({ pubkey: KNOWN_VAULT_PDA, isSigner: false, isWritable: true });
    expect(ix.keys[1]).toEqual({ pubkey: KNOWN_VAULT_USDC_ATA, isSigner: false, isWritable: false });
    expect(ix.keys[2]).toEqual({ pubkey: KNOWN_VAULT_PDA, isSigner: false, isWritable: false });
    expect(ix.keys[3]).toEqual({ pubkey: expectedSwigWalletAddress, isSigner: false, isWritable: false });
    expect(ix.keys[4]).toEqual({ pubkey: INSTRUCTIONS_SYSVAR_ID, isSigner: false, isWritable: false });
    expect(ix.keys[5]).toEqual({ pubkey: expectedSessionPda, isSigner: false, isWritable: true });
    expect(ix.keys[6]).toEqual({ pubkey: KNOWN_DESTINATION, isSigner: true, isWritable: true });
    expect(ix.keys[7]).toEqual({ pubkey: SystemProgram.programId, isSigner: false, isWritable: false });
  });

  test('revoke_session_key', async () => {
    const ix = buildRevokeSessionKeyInstruction({
      vaultPda: KNOWN_VAULT_PDA,
      allowedCounterparty: KNOWN_COUNTERPARTY,
      clientDataJSON: KNOWN_CLIENT_DATA,
      authenticatorData: KNOWN_AUTH_DATA,
    });
    // V6: allowed_counterparty(32) FIRST, then the two vecs.
    expect(ix.data.length).toBe(8 + 32 + (4 + 4) + (4 + 4));
    expect(Buffer.from(ix.data.subarray(8, 40))).toEqual(KNOWN_COUNTERPARTY.toBuffer());
    expect(new Uint8Array(ix.data)).toMatchSnapshot('revoke_session_key data');
    // V6 accounts: vault(w), session PDA(w), instructions_sysvar(r).
    const { deriveSessionPda } = await import('../src/session/index.js');
    const { INSTRUCTIONS_SYSVAR_ID } = await import('../src/constants/index.js');
    const [expectedSessionPda] = deriveSessionPda(KNOWN_VAULT_PDA, KNOWN_COUNTERPARTY);
    expect(ix.keys).toEqual([
      { pubkey: KNOWN_VAULT_PDA, isSigner: false, isWritable: true },
      { pubkey: expectedSessionPda, isSigner: false, isWritable: true },
      { pubkey: INSTRUCTIONS_SYSVAR_ID, isSigner: false, isWritable: false },
    ]);
  });

  test('settle_tab_voucher', async () => {
    const ix = buildSettleTabVoucherInstruction({
      vaultPda: KNOWN_VAULT_PDA,
      swigAddress: KNOWN_VAULT_PDA,
      dexterAuthority: KNOWN_COUNTERPARTY,
      allowedCounterparty: KNOWN_COUNTERPARTY,
      channelId: KNOWN_CHANNEL_ID,
      cumulativeAmount: 12_345n,
      sequenceNumber: 7,
    });
    // V6: allowed_counterparty(32) appended LAST after channel/cumulative/sequence.
    expect(ix.data.length).toBe(8 + 32 + 8 + 4 + 32);
    expect(Buffer.from(ix.data.subarray(52, 84))).toEqual(KNOWN_COUNTERPARTY.toBuffer());
    expect(new Uint8Array(ix.data)).toMatchSnapshot('settle_tab_voucher data');
    // V6: session PDA inserted at index 3 (writable) — 6 accounts total.
    const { deriveSessionPda } = await import('../src/session/index.js');
    const [expectedSessionPda] = deriveSessionPda(KNOWN_VAULT_PDA, KNOWN_COUNTERPARTY);
    expect(ix.keys).toHaveLength(6);
    expect(ix.keys[3]).toEqual({ pubkey: expectedSessionPda, isSigner: false, isWritable: true });
    expect(ix.keys.map(k => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable }))).toMatchSnapshot('settle_tab_voucher keys');
  });

  test('prove_passkey', () => {
    const ix = buildProvePasskeyInstruction({
      vaultPda: KNOWN_VAULT_PDA,
      challenge: new Uint8Array(32).fill(0x11),
      clientDataJSON: KNOWN_CLIENT_DATA,
      authenticatorData: KNOWN_AUTH_DATA,
    });
    expect(new Uint8Array(ix.data)).toMatchSnapshot('prove_passkey data');
  });

  test('request_withdrawal', () => {
    const ix = buildRequestWithdrawalInstruction({
      vaultPda: KNOWN_VAULT_PDA,
      amount: 100_000n,
      destination: KNOWN_DESTINATION,
      signedAt: 1735689600n,
      clientDataJSON: KNOWN_CLIENT_DATA,
      authenticatorData: KNOWN_AUTH_DATA,
    });
    expect(new Uint8Array(ix.data)).toMatchSnapshot('request_withdrawal data');
  });

  test('finalize_withdrawal (no node — non-credit vault, None sentinel at idx 4)', () => {
    const ix = buildFinalizeWithdrawalInstruction({
      vaultPda: KNOWN_VAULT_PDA,
      swigAddress: KNOWN_VAULT_PDA,
      vaultUsdcAta: KNOWN_VAULT_USDC_ATA,
      clientDataJSON: KNOWN_CLIENT_DATA,
      authenticatorData: KNOWN_AUTH_DATA,
    });
    expect(new Uint8Array(ix.data)).toMatchSnapshot('finalize_withdrawal data');
    const finalizeKeys = ix.keys.map(k => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable }));
    // 6-account layout: swig, swig_wallet_address, vault, vault_usdc_ata(3), node(4 OPTIONAL), instructions_sysvar(5)
    expect(finalizeKeys).toHaveLength(6);
    expect(finalizeKeys[3]).toEqual({ pubkey: KNOWN_VAULT_USDC_ATA.toBase58(), isSigner: false, isWritable: false });
    // node omitted → Anchor None sentinel is the program id itself
    expect(finalizeKeys[4].pubkey).toEqual(ix.programId.toBase58());
    expect(finalizeKeys).toMatchSnapshot('finalize_withdrawal keys');
  });

  test('finalize_withdrawal (welded vault — node Some at idx 4)', () => {
    const ix = buildFinalizeWithdrawalInstruction({
      vaultPda: KNOWN_VAULT_PDA,
      swigAddress: KNOWN_VAULT_PDA,
      vaultUsdcAta: KNOWN_VAULT_USDC_ATA,
      node: KNOWN_DESTINATION, // stand-in pubkey for the welded PrincipalNode
      clientDataJSON: KNOWN_CLIENT_DATA,
      authenticatorData: KNOWN_AUTH_DATA,
    });
    const keys = ix.keys.map(k => k.pubkey.toBase58());
    expect(keys).toHaveLength(6);
    expect(keys[4]).toEqual(KNOWN_DESTINATION.toBase58());
  });

  test('force_release', () => {
    const ix = buildForceReleaseInstruction({
      vaultPda: KNOWN_VAULT_PDA,
      clientDataJSON: KNOWN_CLIENT_DATA,
      authenticatorData: KNOWN_AUTH_DATA,
    });
    expect(new Uint8Array(ix.data)).toMatchSnapshot('force_release data');
  });

  test('rotate_passkey', () => {
    const ix = buildRotatePasskeyInstruction({
      vaultPda: KNOWN_VAULT_PDA,
      newPasskeyPubkey: KNOWN_NEW_PASSKEY,
      clientDataJSON: KNOWN_CLIENT_DATA,
      authenticatorData: KNOWN_AUTH_DATA,
    });
    expect(new Uint8Array(ix.data)).toMatchSnapshot('rotate_passkey data');
  });

  test('rotate_dexter_authority', () => {
    const ix = buildRotateDexterAuthorityInstruction({
      vaultPda: KNOWN_VAULT_PDA,
      currentDexterAuthority: KNOWN_COUNTERPARTY,
      newDexterAuthority: KNOWN_DESTINATION,
    });
    expect(new Uint8Array(ix.data)).toMatchSnapshot('rotate_dexter_authority data');
  });

  test('set_swig_atomic — instruction byte layout is locked', () => {
    // Fixed-seed fixture so the snapshot is deterministic.
    const vaultPda = new PublicKey('11111111111111111111111111111112');
    const swigAddress = new PublicKey('11111111111111111111111111111113');
    const swigWalletAddress = new PublicKey('11111111111111111111111111111114');
    const feePayer = new PublicKey('11111111111111111111111111111115');
    const dexterMasterPubkey = new PublicKey('11111111111111111111111111111116');
    const swigId = new Uint8Array(32).fill(0xAA);
    const clientDataJSON = new TextEncoder().encode(
      '{"type":"webauthn.get","challenge":"abc","origin":"https://dexter.cash"}',
    );
    const authenticatorData = new Uint8Array(37).fill(0xBB);

    const ix = buildSetSwigAtomicInstruction({
      vaultPda,
      swigAddress,
      swigWalletAddress,
      feePayer,
      dexterMasterPubkey,
      swigId,
      swigAccountBump: 0xFC,
      swigWalletAddressBump: 0xFD,
      clientDataJSON,
      authenticatorData,
    });

    // Lock the wire format.
    expect(ix.programId.toBase58()).toBe('Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc');
    expect(Buffer.from(ix.data).toString('hex')).toMatchSnapshot('set_swig_atomic-data');
    expect(ix.keys.map((k) => ({
      pubkey: k.pubkey.toBase58(),
      isSigner: k.isSigner,
      isWritable: k.isWritable,
    }))).toMatchSnapshot('set_swig_atomic-keys');

    // Discriminator sanity: first 8 bytes of data must equal SET_SWIG_ATOMIC_DISCRIMINATOR.
    expect(Buffer.from(ix.data.subarray(0, 8))).toEqual(Buffer.from(SET_SWIG_ATOMIC_DISCRIMINATOR));
  });

  test('settle_voucher (counter ix)', async () => {
    const ix = buildSettleVoucherInstruction({
      vaultPda: KNOWN_VAULT_PDA,
      dexterAuthority: KNOWN_COUNTERPARTY,
      allowedCounterparty: KNOWN_COUNTERPARTY,
      amount: 12_345n,
      increment: true,
    });
    // V6: allowed_counterparty(32) appended LAST after amount(u64) + increment(bool).
    expect(ix.data.length).toBe(8 + 8 + 1 + 32);
    expect(Buffer.from(ix.data.subarray(17, 49))).toEqual(KNOWN_COUNTERPARTY.toBuffer());
    expect(new Uint8Array(ix.data)).toMatchSnapshot('settle_voucher data');
    // V6: increment=true path carries the REAL session PDA at index 2 (writable).
    const { deriveSessionPda } = await import('../src/session/index.js');
    const [expectedSessionPda] = deriveSessionPda(KNOWN_VAULT_PDA, KNOWN_COUNTERPARTY);
    expect(ix.keys).toHaveLength(3);
    expect(ix.keys[2]).toEqual({ pubkey: expectedSessionPda, isSigner: false, isWritable: true });
    expect(ix.keys.map(k => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable }))).toMatchSnapshot('settle_voucher keys');

    // increment=false (close) path: Anchor optional-account None sentinel = program ID.
    const closeIx = buildSettleVoucherInstruction({
      vaultPda: KNOWN_VAULT_PDA,
      dexterAuthority: KNOWN_COUNTERPARTY,
      allowedCounterparty: KNOWN_COUNTERPARTY,
      amount: 12_345n,
      increment: false,
    });
    expect(closeIx.keys[2]).toEqual({ pubkey: KNOWN_PROGRAM_ID, isSigner: false, isWritable: false });
  });

  test('buildSetSwigAtomicFromIdentity — produces same bytes as low-level builder', async () => {
    const { buildSetSwigAtomicInstruction, buildSetSwigAtomicFromIdentity } = await import('../src/instructions/setSwigAtomic.js');
    const { SWIG_PROGRAM_ID } = await import('../src/constants/index.js');
    const { createHmac } = await import('node:crypto');

    const identitySeed = new Uint8Array(16).fill(0x42);
    const hmacKey = new Uint8Array(32).fill(0x13);
    const vaultPda = new PublicKey('11111111111111111111111111111112');
    const feePayer = new PublicKey('11111111111111111111111111111115');
    const dexterMasterPubkey = new PublicKey('11111111111111111111111111111116');
    const clientDataJSON = new TextEncoder().encode(
      '{"type":"webauthn.get","challenge":"abc","origin":"https://dexter.cash"}',
    );
    const authenticatorData = new Uint8Array(37).fill(0xBB);

    // High-level call
    const hi = buildSetSwigAtomicFromIdentity({
      vaultPda,
      feePayer,
      dexterMasterPubkey,
      identitySeed,
      hmacKey,
      clientDataJSON,
      authenticatorData,
    });

    // Reproduce the derivation the wrapper does, then call the low-level builder
    const swigId = new Uint8Array(
      createHmac('sha256', Buffer.from(hmacKey))
        .update('dexter-swig-id:v1:')
        .update(Buffer.from(identitySeed))
        .digest(),
    );
    const [swigAddress, swigAccountBump] = PublicKey.findProgramAddressSync(
      [Buffer.from('swig'), Buffer.from(swigId)],
      SWIG_PROGRAM_ID,
    );
    const [swigWalletAddress, swigWalletAddressBump] = PublicKey.findProgramAddressSync(
      [Buffer.from('swig-wallet-address'), swigAddress.toBytes()],
      SWIG_PROGRAM_ID,
    );

    const lo = buildSetSwigAtomicInstruction({
      vaultPda,
      swigAddress,
      swigWalletAddress,
      feePayer,
      dexterMasterPubkey,
      swigId,
      swigAccountBump,
      swigWalletAddressBump,
      clientDataJSON,
      authenticatorData,
    });

    expect(Buffer.from(hi.data)).toEqual(Buffer.from(lo.data));
    expect(hi.keys.map((k) => ({
      pubkey: k.pubkey.toBase58(),
      isSigner: k.isSigner,
      isWritable: k.isWritable,
    }))).toEqual(lo.keys.map((k) => ({
      pubkey: k.pubkey.toBase58(),
      isSigner: k.isSigner,
      isWritable: k.isWritable,
    })));
    expect(hi.programId.toBase58()).toEqual(lo.programId.toBase58());
  });
});
