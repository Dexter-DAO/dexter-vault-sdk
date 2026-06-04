import { describe, test, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { DISCRIMINATORS, OTS_SESSION_REGISTER_V1_DOMAIN, OTS_SESSION_REVOKE_V1_DOMAIN } from '../src/constants/index.js';
import { sessionRegisterMessage, sessionRevokeMessage, voucherPayloadMessage, buildVoucherMessage, buildSetSwigOperationMessage } from '../src/messages/index.js';
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
});

// ── Message layouts ──

describe('message layouts', () => {
  test('180-byte session registration', () => {
    const bytes = sessionRegisterMessage({
      programId: KNOWN_PROGRAM_ID,
      vaultPda: KNOWN_VAULT_PDA,
      sessionPubkey: KNOWN_SESSION_PUBKEY,
      maxAmount: 1_000_000n,
      expiresAt: 1735689600n,
      allowedCounterparty: KNOWN_COUNTERPARTY,
      nonce: 42,
    });
    expect(bytes.length).toBe(180);
    expect(bytes.subarray(0, 32)).toEqual(OTS_SESSION_REGISTER_V1_DOMAIN);
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

  test('register_session_key', () => {
    const ix = buildRegisterSessionKeyInstruction({
      vaultPda: KNOWN_VAULT_PDA,
      sessionPubkey: KNOWN_SESSION_PUBKEY,
      maxAmount: 1_000_000n,
      expiresAt: 1735689600n,
      allowedCounterparty: KNOWN_COUNTERPARTY,
      nonce: 42,
      clientDataJSON: KNOWN_CLIENT_DATA,
      authenticatorData: KNOWN_AUTH_DATA,
    });
    expect(new Uint8Array(ix.data)).toMatchSnapshot('register_session_key data');
  });

  test('revoke_session_key', () => {
    const ix = buildRevokeSessionKeyInstruction({
      vaultPda: KNOWN_VAULT_PDA,
      clientDataJSON: KNOWN_CLIENT_DATA,
      authenticatorData: KNOWN_AUTH_DATA,
    });
    expect(new Uint8Array(ix.data)).toMatchSnapshot('revoke_session_key data');
  });

  test('settle_tab_voucher', () => {
    const ix = buildSettleTabVoucherInstruction({
      vaultPda: KNOWN_VAULT_PDA,
      swigAddress: KNOWN_VAULT_PDA,
      dexterAuthority: KNOWN_COUNTERPARTY,
      channelId: KNOWN_CHANNEL_ID,
      cumulativeAmount: 12_345n,
      sequenceNumber: 7,
    });
    expect(new Uint8Array(ix.data)).toMatchSnapshot('settle_tab_voucher data');
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

  test('finalize_withdrawal', () => {
    const ix = buildFinalizeWithdrawalInstruction({
      vaultPda: KNOWN_VAULT_PDA,
      swigAddress: KNOWN_VAULT_PDA,
      clientDataJSON: KNOWN_CLIENT_DATA,
      authenticatorData: KNOWN_AUTH_DATA,
    });
    expect(new Uint8Array(ix.data)).toMatchSnapshot('finalize_withdrawal data');
    expect(ix.keys.map(k => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable }))).toMatchSnapshot('finalize_withdrawal keys');
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

  test('settle_voucher (legacy counter ix)', () => {
    const ix = buildSettleVoucherInstruction({
      vaultPda: KNOWN_VAULT_PDA,
      dexterAuthority: KNOWN_COUNTERPARTY,
      amount: 12_345n,
      increment: true,
    });
    expect(new Uint8Array(ix.data)).toMatchSnapshot('settle_voucher data');
    expect(ix.keys.map(k => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable }))).toMatchSnapshot('settle_voucher keys');
  });
});
