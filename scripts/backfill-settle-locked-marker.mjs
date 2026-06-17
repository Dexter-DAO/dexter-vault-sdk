#!/usr/bin/env node
/**
 * backfill-settle-locked-marker.mjs — BUILD-ONLY (deploy-gated) backfill helper.
 *
 * WHAT THIS DOES
 *   Adds the `settle_locked_voucher` Swig ProgramExec MARKER authority to an
 *   EXISTING vault swig. Vaults enrolled before commit be6be5e (which added the
 *   marker to the canonical creation bundle) DO NOT have a role that can
 *   authorize the locked-claim settle SignV2 — so settle_locked_voucher would be
 *   un-authorizable on those swigs. This script backfills exactly that one role.
 *
 * WHY A SEPARATE SCRIPT (not buildRegisterProgramAuthority)
 *   src/instructions/registerProgramAuthority.ts builds an *Ed25519 programLimit*
 *   authority (createEd25519AuthorityInfo + Actions.programLimit) — that is the
 *   financier/standby provisioning path, NOT a ProgramExec marker. The marker is
 *   built the way swigBundle.ts builds role 3:
 *     createProgramExecAuthorityInfo(vaultProgramIdBytes, MARKER) + Actions.all()
 *   This script MIRRORS the registerProgramAuthority POST-ENROLLMENT MECHANISM
 *   (fetchSwig -> getAddAuthorityInstructions(swig, signerRole, authInfo, actions)
 *   -> bridge kit ix -> web3 ix; caller submits + confirms) but supplies the
 *   ProgramExec marker authorityInfo instead of the Ed25519 one. Same kit calls
 *   (getAddAuthorityInstructions) the SDK helper uses; different authInfo.
 *
 * SAFETY MODEL — BUILD-ONLY BY DEFAULT
 *   Running this against real vaults is deploy-gated on the repo owner's explicit
 *   go. Without --submit the script STOPS after assembling + printing the tx for
 *   human review. --submit exists (so the tool is complete) but signing requires
 *   the swig manage-authority secret (env SWIG_MANAGE_AUTHORITY_SECRET, base58 or
 *   JSON array) and is intentionally the only path that touches the network for
 *   writes.
 *
 * USAGE
 *   SOLANA_RPC_URL=https://… \
 *   node scripts/backfill-settle-locked-marker.mjs --swig <SWIG_PUBKEY> [--fee-payer <PUBKEY>]
 *
 *   # dry-run (no network, proves assembly logic — mirrors the SDK unit tests'
 *   # _fetchSwig / _getAddAuthorityInstructions injection):
 *   SOLANA_RPC_URL=https://example.invalid \
 *   node scripts/backfill-settle-locked-marker.mjs --swig <SWIG_PUBKEY> --mock
 *
 *   # actually submit (DEPLOY-GATED — do not run without explicit go):
 *   SOLANA_RPC_URL=https://rpc.dexter.cash \
 *   SWIG_MANAGE_AUTHORITY_SECRET=… \
 *   node scripts/backfill-settle-locked-marker.mjs --swig <SWIG_PUBKEY> --submit
 *
 * HARD RULE: the RPC endpoint is ONLY ever read from env. No URL/key is ever
 * hardcoded. rpc.dexter.cash (write-capable) must still be passed via env.
 */

import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { fetchSwig, getAddAuthorityInstructions } from '@swig-wallet/kit';
import { Actions, createProgramExecAuthorityInfo } from '@swig-wallet/lib';
import { address as kitAddress, createSolanaRpc } from '@solana/kit';
import bs58 from 'bs58';

// SDK is published to dist (not self-linked into node_modules). Import the
// canonical marker + program id from the built ESM exactly as a consumer would.
import { SWIG_PROGRAM_EXEC_PREFIX_SETTLE_LOCKED, waitForRole } from '../dist/instructions/index.js';
import { DEXTER_VAULT_PROGRAM_ID } from '../dist/constants/index.js';
// Use the canonical kit↔web3 bridge from dist (the SDK's single source of truth)
// instead of an inlined copy — it had already drifted (TransactionInstruction
// fallback branch). dist/kit/index.js is a published subpath export.
import { kitInstructionsToWeb3 } from '../dist/kit/index.js';

function parseArgs(argv) {
  const out = { submit: false, mock: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--submit') out.submit = true;
    else if (a === '--mock') out.mock = true;
    else if (a === '--swig') out.swig = argv[++i];
    else if (a === '--fee-payer') out.feePayer = argv[++i];
    else if (a === '--signer-role') {
      const v = argv[++i];
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) {
        throw new Error(`--signer-role must be a non-negative integer, got ${JSON.stringify(v)}`);
      }
      out.signerRole = n;
    }
  }
  return out;
}

function getRpcUrlOrThrow() {
  const url =
    process.env.SOLANA_RPC_URL ||
    process.env.RPC_URL ||
    process.env.HELIUS_RPC_URL;
  if (!url) {
    throw new Error(
      'No RPC endpoint set. Export SOLANA_RPC_URL (or RPC_URL / HELIUS_RPC_URL). ' +
        'NEVER hardcode an RPC URL or key — it must come from env.',
    );
  }
  return url;
}

function loadManageAuthorityKeypair() {
  const raw = process.env.SWIG_MANAGE_AUTHORITY_SECRET;
  if (!raw) {
    throw new Error(
      '--submit requires SWIG_MANAGE_AUTHORITY_SECRET (the role-0 manage-authority ' +
        'secret key, as base58 or a JSON byte array). Refusing to submit without it.',
    );
  }
  let secret;
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    secret = Uint8Array.from(JSON.parse(trimmed));
  } else {
    secret = bs58.decode(trimmed);
  }
  // Keypair.fromSecretKey wants the full 64-byte secret; Keypair.fromSeed wants
  // the 32-byte seed. Return a real web3 Keypair so tx.sign() / .publicKey work.
  if (secret.length === 64) return Keypair.fromSecretKey(secret);
  if (secret.length === 32) return Keypair.fromSeed(secret);
  throw new Error(`manage-authority secret must be 32 or 64 bytes, got ${secret.length}`);
}

/**
 * Read the base58 address the swig's role <roleId> Ed25519 authority is bound to,
 * from a decoded @swig-wallet Swig. Used to assert the manage-authority signer
 * actually matches role 0 before submitting (fail fast, save fees). Returns the
 * base58 string, or null if the SDK shape doesn't expose it. Tolerant of both the
 * Swig class (findRoleById + role.authority.addressString) and raw-ish shapes.
 */
function readRoleSignerAddress(swig, roleId) {
  try {
    let role = null;
    if (typeof swig?.findRoleById === 'function') {
      role = swig.findRoleById(roleId);
    } else {
      const roles = swig?.roles ?? swig?.authorities ?? [];
      role = roles[roleId] ?? null;
    }
    if (!role) return null;
    const authority = role.authority ?? role;
    // Ed25519Authority exposes addressString (base58 of the bound pubkey).
    if (typeof authority?.addressString === 'string') return authority.addressString;
    if (typeof authority?.signerAddressString === 'string') return authority.signerAddressString;
    // Fallbacks: raw address bytes.
    const bytes = authority?.address ?? authority?.signer ?? authority?.id;
    if (bytes && bytes.length === 32) return new PublicKey(Uint8Array.from(bytes)).toBase58();
    return null;
  } catch {
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rpcUrl = getRpcUrlOrThrow(); // throws if unset, before anything else

  if (!args.swig) {
    throw new Error('Missing --swig <SWIG_PUBKEY> (the existing vault swig to backfill).');
  }
  const swigPubkey = new PublicKey(args.swig);
  const vaultProgramId = DEXTER_VAULT_PROGRAM_ID;
  const signerRole = Number.isInteger(args.signerRole) ? args.signerRole : 0; // role 0 = manageAuthority
  const explicitFeePayer = args.feePayer ? new PublicKey(args.feePayer) : null;

  // ── Resolve signer + fee payer BEFORE building (C2/C3) ──
  // On --submit, the key that signs, the tx.feePayer, and the `payer` passed to
  // the add-authority builder MUST all be the same pubkey, resolved up front.
  // A PDA (the swig) can never be a fee payer/signer, so we never default payer
  // to the swig on the submit path. Load the manage-authority keypair first and
  // derive the fee payer from it; if --fee-payer is also given, assert it matches.
  let signer = null; // web3 Keypair (submit path only)
  let payerPubkey; // the pubkey used as fee payer AND as the builder's `payer`
  if (args.submit) {
    signer = loadManageAuthorityKeypair();
    if (explicitFeePayer && !explicitFeePayer.equals(signer.publicKey)) {
      throw new Error(
        `--fee-payer (${explicitFeePayer.toBase58()}) does not match the manage-authority signer ` +
          `(${signer.publicKey.toBase58()}). On the submit path the fee payer and signer must be the ` +
          `same key — omit --fee-payer or pass the signer's own pubkey.`,
      );
    }
    payerPubkey = signer.publicKey;
  } else {
    // BUILD-ONLY path (unchanged behavior): allow inspecting the tx for any payer,
    // defaulting to the swig only for offline preview. This path never submits.
    payerPubkey = explicitFeePayer ?? swigPubkey;
  }

  console.log('── settle_locked marker backfill (BUILD-ONLY unless --submit) ──');
  console.log(`  swig:            ${swigPubkey.toBase58()}`);
  console.log(`  vault program:   ${vaultProgramId.toBase58()}`);
  console.log(`  marker (hex):    ${Buffer.from(SWIG_PROGRAM_EXEC_PREFIX_SETTLE_LOCKED).toString('hex')}`);
  console.log(`  signer role:     ${signerRole} (manageAuthority)`);
  console.log(`  fee payer/payer: ${payerPubkey.toBase58()}${args.submit ? ' (= manage-authority signer)' : ' (build-only preview)'}`);
  console.log(`  rpc:             ${rpcUrl}`);
  console.log(`  mode:            ${args.submit ? 'SUBMIT' : 'dry-run (no submit)'}${args.mock ? ' [MOCK fetch]' : ''}`);
  console.log('');

  // ── Build authority info + actions EXACTLY like swigBundle role 3 ──
  const vaultProgramIdBytes = Uint8Array.from(vaultProgramId.toBytes());
  const settleLockedAuthorityInfo = createProgramExecAuthorityInfo(
    vaultProgramIdBytes,
    SWIG_PROGRAM_EXEC_PREFIX_SETTLE_LOCKED,
  );
  const settleLockedActions = Actions.set().all().get();

  // ── Fetch swig (mirrors buildRegisterProgramAuthority). --mock injects a fake
  //    decoded swig + fake add-authority builder so assembly is provable offline,
  //    mirroring the SDK unit tests' _fetchSwig / _getAddAuthorityInstructions. ──
  let swig;
  let addAuthFn = getAddAuthorityInstructions;
  if (args.mock) {
    swig = { roles: [{}, {}, {}, {}] }; // 4 existing canonical roles → new role = 4
    addAuthFn = async (_swig, signerRoleId, authInfo, actions, opts) => {
      // Plumbing stand-in ONLY: emits one kit ix targeting the Swig program so
      // the printed tx's account layout (swig writable + payer writable_signer)
      // is inspectable offline. The `data` here is the 8-byte marker as a FAKE
      // SENTINEL — it is NOT the real add-authority instruction payload (real kit
      // encodes the addAuthorityV1 discriminator + serialized authorityInfo +
      // actions). Do NOT treat the mock `data` bytes as representative of what
      // lands on-chain; only the account roles/structure are a faithful mirror.
      return [
        {
          programAddress: 'swigU5VdxRWZsTzg99puwhq45gpyDU4MJ2gxgsUsuB4',
          accounts: [
            { address: swigPubkey.toBase58(), role: 'writable' },
            { address: payerPubkey.toBase58(), role: 'writable_signer' },
          ],
          data: Uint8Array.from(SWIG_PROGRAM_EXEC_PREFIX_SETTLE_LOCKED), // FAKE sentinel, not real payload
        },
      ];
    };
  } else {
    const rpc = createSolanaRpc(rpcUrl);
    swig = await fetchSwig(rpc, kitAddress(swigPubkey.toBase58()));
    if (!swig) {
      throw new Error(`swig not found on-chain: ${swigPubkey.toBase58()}`);
    }
  }

  const rolesBefore = swig?.roles ?? swig?.authorities ?? [];
  const newRoleId = rolesBefore.length;
  console.log(`  existing roles:  ${rolesBefore.length} → new marker role index: ${newRoleId}`);

  // ── Assert the signer is bound to the swig's signer role BEFORE submitting (C2).
  //    Fail fast off-chain rather than burning fees on an on-chain authority
  //    mismatch. Role <signerRole> (default 0) is an Ed25519 authority bound to
  //    whatever key was fee payer at creation (swigBundle.ts:119). The decoded
  //    Swig exposes findRoleById(id).authority.addressString (base58 of the bound
  //    pubkey). Only enforced on the submit path with a real decoded swig. ──
  if (args.submit && !args.mock) {
    const boundAddress = readRoleSignerAddress(swig, signerRole);
    if (boundAddress == null) {
      throw new Error(
        `Could not read role ${signerRole}'s bound authority address from the decoded swig — ` +
          `refusing to submit without verifying the signer matches. (SDK shape changed?)`,
      );
    }
    if (boundAddress !== signer.publicKey.toBase58()) {
      throw new Error(
        `Signer mismatch: SWIG_MANAGE_AUTHORITY_SECRET resolves to ${signer.publicKey.toBase58()} but ` +
          `role ${signerRole} on swig ${swigPubkey.toBase58()} is bound to ${boundAddress}. The add-authority ` +
          `instruction would be rejected on-chain. Provide the secret for the role-${signerRole} authority.`,
      );
    }
    console.log(`  signer check:    OK — role ${signerRole} bound to ${boundAddress}`);
  }

  const kitIxs = await addAuthFn(
    swig,
    signerRole,
    settleLockedAuthorityInfo,
    settleLockedActions,
    { payer: kitAddress(payerPubkey.toBase58()) },
  );
  const web3Ixs = kitInstructionsToWeb3(kitIxs);

  // ── Print the assembled tx for human review ──
  const tx = new Transaction();
  tx.feePayer = payerPubkey;
  for (const ix of web3Ixs) tx.add(ix);

  console.log(`\n── ASSEMBLED TRANSACTION (${web3Ixs.length} instruction(s)) ──`);
  web3Ixs.forEach((ix, n) => {
    console.log(`  ix[${n}] program: ${ix.programId.toBase58()}`);
    console.log(`         data:    ${Buffer.from(ix.data).toString('hex')} (${ix.data.length} bytes)`);
    ix.keys.forEach((k, ki) => {
      console.log(
        `         acct[${ki}]: ${k.pubkey.toBase58()}  signer=${k.isSigner} writable=${k.isWritable}`,
      );
    });
  });

  // base64 of the unsigned message (no blockhash yet → use message serialize best-effort)
  try {
    tx.recentBlockhash = '11111111111111111111111111111111'; // placeholder for inspection only
    const msgB64 = tx.serializeMessage().toString('base64');
    console.log(`\n  unsigned message (base64, placeholder blockhash):\n  ${msgB64}`);
  } catch (e) {
    console.log(`\n  (could not serialize message for preview: ${e.message})`);
  }

  if (!args.submit) {
    console.log('\n✅ BUILD-ONLY: transaction assembled and printed. NOT submitted.');
    console.log('   Re-run with --submit (and SWIG_MANAGE_AUTHORITY_SECRET set) to send.');
    console.log(`   After confirming, the new settle_locked marker occupies role index ${newRoleId}.`);
    return;
  }

  // ── SUBMIT PATH (deploy-gated; not exercised here) ──
  console.log('\n⚠️  SUBMIT MODE — sending to chain.');
  const connection = new Connection(rpcUrl, 'confirmed');
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  // signer/fee-payer were resolved up front (payerPubkey === signer.publicKey).
  // tx.feePayer is already payerPubkey from assembly above; assert it for safety.
  if (!tx.feePayer.equals(signer.publicKey)) {
    throw new Error(
      `internal: tx.feePayer (${tx.feePayer.toBase58()}) != signer (${signer.publicKey.toBase58()})`,
    );
  }
  tx.sign(signer); // I1: real web3 Keypair, not a hand-rolled {publicKey,secretKey}
  const sig = await connection.sendRawTransaction(tx.serialize());
  console.log(`  submitted: ${sig}`);
  // I2: blockhash-based confirmation strategy + explicit err check.
  const conf = await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    'confirmed',
  );
  if (conf.value?.err) {
    throw new Error(`transaction confirmed with error: ${JSON.stringify(conf.value.err)}`);
  }
  // C1: a confirmed addAuthority is NOT instantly visible on multi-replica
  // mainnet RPC. Poll fetchSwig (via the SDK's waitForRole) until the new role
  // index is visible before claiming success.
  try {
    await waitForRole({ connection, swig: swigPubkey, roleId: newRoleId, timeoutMs: 30_000 });
    console.log(`  ✅ confirmed + visible. settle_locked marker now at role index ${newRoleId}.`);
  } catch (e) {
    console.log(
      `  ✅ submitted + confirmed (sig ${sig}), but role index ${newRoleId} not yet visible ` +
        `via fetchSwig: ${e.message}`,
    );
    console.log(
      `     This is expected multi-replica RPC lag — verify the new role with fetchSwig shortly.`,
    );
  }
}

main().catch((err) => {
  console.error(`\n❌ ${err.message}`);
  process.exit(1);
});
