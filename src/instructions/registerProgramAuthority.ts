/**
 * Register the Program(dexter_vault) authority a financier swig needs to authorize
 * the mechanism-B SignV2 for set_standby_reserve / close_standby{financier}.
 *
 * This is the one provisioning step the rest of the credit surface depends on and
 * that swigBundle.ts does NOT cover (the bundle's roles are ProgramExec MARKERS +
 * session/manage — none is a programLimit-scoped Program authority). Without this,
 * a financier swig cannot back a standby via the SDK.
 *
 * UNLIKE the proven harness helper (dexter-vault/tests/helpers/standby-reserve.ts::
 * registerProgramAuthorityOnSwig) which SENDS the tx + polls, this follows the SDK
 * convention: it BUILDS and RETURNS the add-authority instruction(s) plus the role
 * index the new authority will occupy (the caller submits + confirms, then passes
 * roleId as `programRoleId` to setStandbyReserve/closeStandby).
 *
 * The role index is the count of roles BEFORE the add (Swig appends roles), matching
 * the harness. The caller MUST confirm the add tx before relying on roleId, and MUST
 * NOT interleave other authority adds on the same swig concurrently (would shift the
 * index) — same constraint the harness documents.
 */
import { Connection, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { fetchSwig, getAddAuthorityInstructions } from '@swig-wallet/kit';
import { Actions, createEd25519AuthorityInfo } from '@swig-wallet/lib';
import { address as kitAddress } from '@solana/kit';
import { kitInstructionsToWeb3, getRpc } from '../kit/index.js';

export interface RegisterProgramAuthorityParams {
  connection: Connection;
  /** The financier swig that will back standbys. */
  financierSwig: PublicKey;
  /** The dexter-vault program id (the Program-scoped authority is bound to this). */
  vaultProgramId: PublicKey;
  /** Fee payer for the add-authority tx (also the default authority binding). */
  feePayer: PublicKey;
  /** The pubkey the new Ed25519 authority is bound to: the financier's controlling
   *  key that will authorize the set_standby_reserve / close_standby{financier} SignV2
   *  later. Required (not defaulted to feePayer) so the binding is always an explicit
   *  decision — a fee payer is often a throwaway/relayer key. */
  authorityPubkey: PublicKey;
  /** The swig role index that SIGNS the add-authority instruction. Role 0 is the
   *  bootstrap manageAuthority role in the canonical bundle; default 0. */
  signerRoleId?: number;
  // ── test injection (do not use in production) ──
  _fetchSwig?: typeof fetchSwig;
  _getAddAuthorityInstructions?: typeof getAddAuthorityInstructions;
}

export interface RegisterProgramAuthorityResult {
  instructions: TransactionInstruction[];
  /** The role index the new Program(vault) authority occupies. Pass this as
   *  `programRoleId` to setStandbyReserve / closeStandby. Valid only AFTER the
   *  returned instructions are confirmed on-chain. */
  roleId: number;
}

export async function buildRegisterProgramAuthority(
  p: RegisterProgramAuthorityParams,
): Promise<RegisterProgramAuthorityResult> {
  const fetchSwigFn = p._fetchSwig ?? fetchSwig;
  const addAuth = p._getAddAuthorityInstructions ?? getAddAuthorityInstructions;
  const signerRole = p.signerRoleId ?? 0;
  const authorityKey = p.authorityPubkey;

  const rpc = getRpc(p.connection);
  const swig = await fetchSwigOrThrow(fetchSwigFn, rpc, p.financierSwig);

  const rolesBefore: any[] = (swig as any).roles ?? (swig as any).authorities ?? [];
  const roleId = rolesBefore.length;

  const programAuthority = createEd25519AuthorityInfo(Uint8Array.from(authorityKey.toBytes()));
  const programActions = Actions.set()
    .programLimit({ programId: kitAddress(p.vaultProgramId.toBase58()) })
    .get();

  const kitIxs = await addAuth(
    swig as any,
    signerRole,
    programAuthority,
    programActions,
    { payer: kitAddress(p.feePayer.toBase58()) } as any,
  );

  return { instructions: kitInstructionsToWeb3(kitIxs), roleId };
}

async function fetchSwigOrThrow(fetchSwigFn: typeof fetchSwig, rpc: any, financierSwig: PublicKey) {
  const swig = await fetchSwigFn(rpc, kitAddress(financierSwig.toBase58()));
  if (!swig) {
    throw new Error(
      `registerProgramAuthority: financier swig not found on-chain: ${financierSwig.toBase58()}`,
    );
  }
  return swig;
}
