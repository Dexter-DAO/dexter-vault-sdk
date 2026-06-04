/**
 * buildSetSwigAtomicInstruction — single-tx warmup builder.
 *
 * Companion of buildSetSwigInstruction. Where set_swig binds a pre-existing
 * Swig to a vault, set_swig_atomic CREATES the Swig (with the 4-role layout
 * buildSwigCreationBundle produces) AND binds it — all in one ix that the
 * vault program executes via Swig CPIs.
 *
 * Wire format matches the on-chain Anchor handler's SetSwigAtomicArgs layout:
 *
 *   discriminator (8)
 *   || swig_id (32)
 *   || swig_account_bump (1)
 *   || swig_wallet_address_bump (1)
 *   || dexter_master_pubkey (32)
 *   || client_data_json_len (4 LE) || client_data_json (variable)
 *   || authenticator_data_len (4 LE) || authenticator_data (variable)
 *
 * Discriminator (locked by Anchor's sha256("global:set_swig_atomic")[0..8]):
 *   77 6f f7 d7 be 03 aa 17
 */

import {
  PublicKey,
  TransactionInstruction,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from '@solana/web3.js';
import { DEXTER_VAULT_PROGRAM_ID, SWIG_PROGRAM_ID } from '../constants/index.js';
import { deriveSwigId } from './swigBundle.js';

/** Anchor instruction discriminator = sha256("global:set_swig_atomic")[0..8].
 *  Captured from target/idl/dexter_vault.json after `anchor build` on commit 49aae30. */
export const SET_SWIG_ATOMIC_DISCRIMINATOR = new Uint8Array([
  0x77, 0x6f, 0xf7, 0xd7, 0xbe, 0x03, 0xaa, 0x17,
]);

export interface BuildSetSwigAtomicParams {
  /** dexter-vault PDA — written to (vault.swig_address is updated). */
  vaultPda: PublicKey;
  /** Swig state account PDA (derived from swig_id + Swig program). */
  swigAddress: PublicKey;
  /** Swig wallet PDA (different from swigAddress — it's the spending authority address). */
  swigWalletAddress: PublicKey;
  /** Outer-tx signer + role-0 bootstrap authority + rent payer for the new Swig. */
  feePayer: PublicKey;
  /** Becomes role-2 (Ed25519Session) authority. */
  dexterMasterPubkey: PublicKey;
  /** 32-byte Swig ID (the seed used to derive swigAddress). */
  swigId: Uint8Array;
  /** Bump for swigAddress = findProgramAddress(swig_account_seeds(swigId), SWIG_PROGRAM_ID). */
  swigAccountBump: number;
  /** Bump for swigWalletAddress PDA. */
  swigWalletAddressBump: number;
  /** WebAuthn ceremony output. */
  clientDataJSON: Uint8Array;
  authenticatorData: Uint8Array;
}

export function buildSetSwigAtomicInstruction(
  params: BuildSetSwigAtomicParams,
): TransactionInstruction {
  if (params.swigId.length !== 32) {
    throw new Error(`swigId must be 32 bytes, got ${params.swigId.length}`);
  }
  if (params.authenticatorData.length < 37) {
    throw new Error(`authenticatorData must be at least 37 bytes`);
  }

  const cdj = params.clientDataJSON;
  const ad = params.authenticatorData;

  const dataLen =
    8 + // discriminator
    32 + // swig_id
    1 + // swig_account_bump
    1 + // swig_wallet_address_bump
    32 + // dexter_master_pubkey
    4 + cdj.length + // client_data_json (len-prefixed)
    4 + ad.length;   // authenticator_data (len-prefixed)

  const data = new Uint8Array(dataLen);
  const view = new DataView(data.buffer);
  let off = 0;
  data.set(SET_SWIG_ATOMIC_DISCRIMINATOR, off); off += 8;
  data.set(params.swigId, off); off += 32;
  data[off++] = params.swigAccountBump;
  data[off++] = params.swigWalletAddressBump;
  data.set(params.dexterMasterPubkey.toBytes(), off); off += 32;
  view.setUint32(off, cdj.length, true); off += 4;
  data.set(cdj, off); off += cdj.length;
  view.setUint32(off, ad.length, true); off += 4;
  data.set(ad, off); off += ad.length;

  if (off !== dataLen) throw new Error(`internal: byte offset mismatch (${off} vs ${dataLen})`);

  return new TransactionInstruction({
    programId: DEXTER_VAULT_PROGRAM_ID,
    keys: [
      { pubkey: params.vaultPda, isSigner: false, isWritable: true },
      { pubkey: params.feePayer, isSigner: true, isWritable: true },
      { pubkey: params.swigAddress, isSigner: false, isWritable: true },
      { pubkey: params.swigWalletAddress, isSigner: false, isWritable: true },
      { pubkey: SWIG_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// High-level wrapper
// ─────────────────────────────────────────────────────────────────────────────

export interface BuildSetSwigAtomicFromIdentityParams {
  /** dexter-vault PDA. */
  vaultPda: PublicKey;
  /** Outer-tx signer + role-0 bootstrap authority. */
  feePayer: PublicKey;
  /** Becomes role-2 (Ed25519Session) authority. */
  dexterMasterPubkey: PublicKey;
  /** Operator identity seed (e.g. 16-byte UUID). */
  identitySeed: Uint8Array;
  /**
   * 32-byte HMAC key for swig_id derivation. MUST match the key
   * buildSwigCreationBundle uses, or the derived swigId will not match
   * the expected on-chain PDA.
   */
  hmacKey: Uint8Array;
  /** WebAuthn ceremony outputs. */
  clientDataJSON: Uint8Array;
  authenticatorData: Uint8Array;
}

/**
 * High-level convenience wrapper around buildSetSwigAtomicInstruction.
 *
 * Derives the 32-byte swigId via HMAC(identitySeed, hmacKey) using the
 * SAME deriveSwigId helper as buildSwigCreationBundle, then finds the
 * Swig state PDA and the Swig wallet PDA (with their bumps), then
 * delegates to the low-level builder.
 *
 * Suitable for normal callers. Use the low-level builder directly only
 * when you need to control swigId derivation yourself (e.g., byte-parity
 * snapshot tests).
 */
export function buildSetSwigAtomicFromIdentity(
  params: BuildSetSwigAtomicFromIdentityParams,
): TransactionInstruction {
  const swigId = Uint8Array.from(
    deriveSwigId(params.identitySeed, params.hmacKey),
  );

  const [swigAddress, swigAccountBump] = PublicKey.findProgramAddressSync(
    [Buffer.from(swigId)],
    SWIG_PROGRAM_ID,
  );
  const [swigWalletAddress, swigWalletAddressBump] = PublicKey.findProgramAddressSync(
    [swigAddress.toBytes()],
    SWIG_PROGRAM_ID,
  );

  return buildSetSwigAtomicInstruction({
    vaultPda: params.vaultPda,
    swigAddress,
    swigWalletAddress,
    feePayer: params.feePayer,
    dexterMasterPubkey: params.dexterMasterPubkey,
    swigId,
    swigAccountBump,
    swigWalletAddressBump,
    clientDataJSON: params.clientDataJSON,
    authenticatorData: params.authenticatorData,
  });
}
