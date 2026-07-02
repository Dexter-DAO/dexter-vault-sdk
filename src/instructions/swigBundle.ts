/**
 * Canonical 8-authority Swig provisioning bundle.
 *
 * THE ONLY place in the codebase that knows about Swig roles. Every enrollment
 * path — dexter-api production, dexter-vault tests, future consumers — calls
 * this. The drift bug that ate 4 hours on 2026-06-02 is structurally impossible
 * because the role list lives in exactly one file. This bundle mints the SAME
 * authority SET as the program's set_swig_atomic (2026-07-01 reconciliation) so a
 * vault's capabilities never depend on which builder created it. Sign-time
 * resolves ProgramExec roles BY MARKER, so index order across the two paths is
 * immaterial — only the SET must match.
 *
 * Role assignment (roles 0-4 locked; 5/6 appended 2026-07-01; 7 appended 2026-07-02).
 * NOTE: index order here differs from the program's set_swig_atomic — that's FINE.
 * Sign-time resolves BY MARKER, so only the SET of markers must match, not the order.
 *   role 0 — Ed25519(fee-payer), manageAuthority only (bootstrap; can't spend)
 *   role 1 — ProgramExec(vault, marker=finalize_withdrawal), all (withdraw path)
 *   role 2 — Ed25519Session(master, TTL'd + token-limited), all (streaming spend)
 *   role 3 — ProgramExec(vault, marker=settle_tab_voucher), all (Tab settle path)
 *   role 4 — ProgramExec(vault, marker=settle_locked_voucher), all (lock settle)
 *   role 5 — ProgramExec(vault, marker=repay_credit), all (recourse repay leg)
 *   role 6 — ProgramExec(vault, marker=seize_collateral), all (recourse seize leg)
 *   role 7 — ProgramExec(vault, marker=seize_ancestor), all (RUNG-3 cascade leg)
 *
 * The HMAC key the Swig-id derivation needs is a CALLER-PROVIDED 32-byte
 * seed. Production passes its session-master secret; tests pass a stable
 * random seed they generated themselves. The package never touches process.env.
 */

import { createHmac } from 'node:crypto';
import {
  getInstructionsFromContext,
  findSwigPda,
  fetchNullableSwig,
} from '@swig-wallet/kit';
import {
  Actions,
  createProgramExecAuthorityInfo,
  createEd25519AuthorityInfo,
  createEd25519SessionAuthorityInfo,
  getCreateSwigWithMultipleAuthoritiesInstructionContextBuilder,
} from '@swig-wallet/lib';
import { address, createSolanaRpc } from '@solana/kit';
// bs58@6 ships as a CJS module whose `module.exports` is `{ default: <instance> }`.
// tsup/esbuild's CJS interop double-wraps that, leaving `bs58.decode` undefined
// in the emitted .cjs file even though the ESM bundle is fine. Workaround:
// import the namespace, then peel one layer of `.default` if present. Works
// identically under ESM and CJS without changing call sites.
import * as bs58Module from 'bs58';
const bs58: { decode(s: string): Uint8Array; encode(b: Uint8Array): string } =
  (bs58Module as any).default ?? bs58Module;
import { PublicKey } from '@solana/web3.js';

import { DEXTER_VAULT_PROGRAM_ID, USDC_MAINNET, DISCRIMINATORS } from '../constants/index.js';

const SWIG_ID_DOMAIN = 'dexter-swig-id:v1:';
const DEFAULT_SESSION_TTL_SECONDS = BigInt(30 * 24 * 60 * 60);
const DEFAULT_SPEND_LIMIT_ATOMIC = BigInt(1_000_000_000);

export const SWIG_PROGRAM_EXEC_PREFIX = new Uint8Array([
  178, 87, 206, 68, 201, 186, 164, 232,
]);
export const SWIG_PROGRAM_EXEC_PREFIX_SETTLE_TAB = new Uint8Array([
  173, 22, 98, 31, 110, 129, 59, 161,
]);
export const SWIG_PROGRAM_EXEC_PREFIX_SETTLE_LOCKED = new Uint8Array(
  DISCRIMINATORS.settle_locked_voucher,
);
// Recourse money-leg markers (added 2026-07-01, reconciling this client bundle
// with the program's set_swig_atomic so both mint the same canonical role set).
// MUST match set_swig_atomic.rs SWIG_MARKER_REPAY_CREDIT / SWIG_MARKER_SEIZE_COLLATERAL.
export const SWIG_PROGRAM_EXEC_PREFIX_REPAY = new Uint8Array(
  DISCRIMINATORS.repay_credit,
);
export const SWIG_PROGRAM_EXEC_PREFIX_SEIZE = new Uint8Array(
  DISCRIMINATORS.seize_collateral,
);
// RUNG-3 cascade money-leg marker (added 2026-07-02, → canonical 8-authority set).
// MUST match set_swig_atomic.rs SWIG_MARKER_SEIZE_ANCESTOR.
export const SWIG_PROGRAM_EXEC_PREFIX_SEIZE_ANCESTOR = new Uint8Array(
  DISCRIMINATORS.seize_ancestor,
);
export const SWIG_PROGRAM_EXEC_MARKERS: readonly Uint8Array[] = [
  SWIG_PROGRAM_EXEC_PREFIX,
  SWIG_PROGRAM_EXEC_PREFIX_SETTLE_TAB,
  SWIG_PROGRAM_EXEC_PREFIX_SETTLE_LOCKED,
  SWIG_PROGRAM_EXEC_PREFIX_REPAY,
  SWIG_PROGRAM_EXEC_PREFIX_SEIZE,
  SWIG_PROGRAM_EXEC_PREFIX_SEIZE_ANCESTOR,
];

/**
 * HMAC-derive the 32-byte swigId used as the Swig state PDA seed.
 *
 * Exported so the high-level buildSetSwigAtomicFromIdentity wrapper in
 * setSwigAtomic.ts can share the SAME derivation function — keeping a
 * single source of truth and avoiding silent drift between the two
 * paths that produce the same on-chain seed.
 */
export function deriveSwigId(identitySeed: Uint8Array, hmacKey: Uint8Array): Buffer {
  if (hmacKey.length !== 32) {
    throw new Error(`hmacKey must be 32 bytes, got ${hmacKey.length}`);
  }
  return createHmac('sha256', Buffer.from(hmacKey))
    .update(SWIG_ID_DOMAIN)
    .update(Buffer.from(identitySeed))
    .digest();
}

export interface BuildSwigCreationBundleParams {
  feePayer: string;             // base58
  dexterMasterPubkey: string;   // base58
  identitySeed: Uint8Array;
  /** 32-byte HMAC key for Swig-id derivation. Caller-provided (no env access). */
  hmacKey: Uint8Array;
  sessionTtlSeconds?: bigint;
  spendLimitAtomic?: bigint;
}

export interface SwigCreationBundleOutput {
  swigAddress: string;
  swigIdBase58: string;
  instructions: any[];
}

export async function buildSwigCreationBundle(
  params: BuildSwigCreationBundleParams,
): Promise<SwigCreationBundleOutput> {
  const {
    feePayer,
    dexterMasterPubkey,
    identitySeed,
    hmacKey,
    sessionTtlSeconds = DEFAULT_SESSION_TTL_SECONDS,
    spendLimitAtomic = DEFAULT_SPEND_LIMIT_ATOMIC,
  } = params;

  const swigId = deriveSwigId(identitySeed, hmacKey);
  const swigPda = await findSwigPda(swigId);
  const swigAddressStr = String(swigPda);

  const feePayerBytes = bs58.decode(feePayer);
  const vaultProgramIdBytes = Uint8Array.from(DEXTER_VAULT_PROGRAM_ID.toBytes());
  const dexterPubkeyBytes = bs58.decode(dexterMasterPubkey);

  const bootstrapAuthorityInfo = createEd25519AuthorityInfo(feePayerBytes);
  const bootstrapActions = Actions.set().manageAuthority().get();

  const vaultAuthorityInfo = createProgramExecAuthorityInfo(
    vaultProgramIdBytes,
    SWIG_PROGRAM_EXEC_PREFIX,
  );
  const vaultActions = Actions.set().all().get();

  const vaultTabSettleAuthorityInfo = createProgramExecAuthorityInfo(
    vaultProgramIdBytes,
    SWIG_PROGRAM_EXEC_PREFIX_SETTLE_TAB,
  );
  const vaultTabSettleActions = Actions.set().all().get();

  const vaultSettleLockedAuthorityInfo = createProgramExecAuthorityInfo(
    vaultProgramIdBytes,
    SWIG_PROGRAM_EXEC_PREFIX_SETTLE_LOCKED,
  );
  const vaultSettleLockedActions = Actions.set().all().get();

  const vaultRepayAuthorityInfo = createProgramExecAuthorityInfo(
    vaultProgramIdBytes,
    SWIG_PROGRAM_EXEC_PREFIX_REPAY,
  );
  const vaultRepayActions = Actions.set().all().get();

  const vaultSeizeAuthorityInfo = createProgramExecAuthorityInfo(
    vaultProgramIdBytes,
    SWIG_PROGRAM_EXEC_PREFIX_SEIZE,
  );
  const vaultSeizeActions = Actions.set().all().get();

  const vaultSeizeAncestorAuthorityInfo = createProgramExecAuthorityInfo(
    vaultProgramIdBytes,
    SWIG_PROGRAM_EXEC_PREFIX_SEIZE_ANCESTOR,
  );
  const vaultSeizeAncestorActions = Actions.set().all().get();

  const sessionAuthorityInfo = createEd25519SessionAuthorityInfo(
    dexterPubkeyBytes,
    sessionTtlSeconds,
  );
  const sessionActions = Actions.set()
    .tokenLimit({ mint: bs58.decode(USDC_MAINNET), amount: spendLimitAtomic })
    .programAll()
    .get();

  const builder = getCreateSwigWithMultipleAuthoritiesInstructionContextBuilder({
    payer: address(feePayer),
    swigAddress: address(swigAddressStr),
    id: swigId,
    actions: bootstrapActions,
    authorityInfo: bootstrapAuthorityInfo,
    options: {},
  })
    .addAuthority(vaultAuthorityInfo, vaultActions)
    .addAuthority(sessionAuthorityInfo, sessionActions)
    .addAuthority(vaultTabSettleAuthorityInfo, vaultTabSettleActions)
    .addAuthority(vaultSettleLockedAuthorityInfo, vaultSettleLockedActions)
    .addAuthority(vaultRepayAuthorityInfo, vaultRepayActions)
    .addAuthority(vaultSeizeAuthorityInfo, vaultSeizeActions)
    .addAuthority(vaultSeizeAncestorAuthorityInfo, vaultSeizeAncestorActions);

  const contexts = await builder.getInstructionContexts();
  const instructions = contexts.flatMap((ctx) => getInstructionsFromContext(ctx));

  return {
    swigAddress: swigAddressStr,
    swigIdBase58: bs58.encode(swigId),
    instructions,
  };
}

export async function expectedSwigAddressFor(
  identitySeed: Uint8Array,
  hmacKey: Uint8Array,
): Promise<string> {
  const swigId = deriveSwigId(identitySeed, hmacKey);
  return String(await findSwigPda(swigId));
}

export interface SwigOwnershipCheck {
  ok: boolean;
  reason?: string;
}

export async function verifySwigIsOurs(params: {
  swigAddress: string;
  identitySeed: Uint8Array;
  hmacKey: Uint8Array;
  dexterMasterPubkey: string;
  rpcEndpoint: string;
}): Promise<SwigOwnershipCheck> {
  const { swigAddress, identitySeed, hmacKey, dexterMasterPubkey, rpcEndpoint } = params;

  const expected = await expectedSwigAddressFor(identitySeed, hmacKey);
  if (swigAddress !== expected) {
    return {
      ok: false,
      reason: `swig_address_mismatch: expected ${expected}, got ${swigAddress}`,
    };
  }

  try {
    const rpc: any = createSolanaRpc(rpcEndpoint);
    const swig = await fetchNullableSwig(rpc, address(swigAddress));
    if (swig) {
      const ourRoles = swig.findRolesByAuthorityAddress(bs58.decode(dexterMasterPubkey));
      if (!ourRoles || ourRoles.length === 0) {
        return {
          ok: false,
          reason: 'swig_missing_session_master_role',
        };
      }
    }
  } catch {
    // RPC failure here doesn't hard-block — the address match already proved ownership.
  }

  return { ok: true };
}

/**
 * deriveVaultPda — supabaseUserId is the 16-byte UUID; the vault PDA seeds are
 * ["vault", supabaseUserId]. Kept here because it's the canonical Swig-pair PDA
 * derivation. Mirror of dexter-api/src/vault/instructions.ts.
 */
export function deriveVaultPda(supabaseUserId: Uint8Array): {
  pda: PublicKey;
  bump: number;
} {
  if (supabaseUserId.length !== 16) {
    throw new Error('supabaseUserId must be 16 bytes (UUID v4)');
  }
  const [pda, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), Buffer.from(supabaseUserId)],
    DEXTER_VAULT_PROGRAM_ID,
  );
  return { pda, bump };
}
