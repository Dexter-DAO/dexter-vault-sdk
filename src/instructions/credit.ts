/**
 * Credit-L2 instruction builders — the standby-credit lifecycle.
 * Mirrors the on-chain Anchor structs in
 * programs/dexter-vault/src/instructions/{open_standby,draw_credit,repay_credit,
 * seize_collateral,migrate_v4_to_v5}.rs. Account ordering is consensus-critical
 * and MUST match the program exactly.
 */
import {
  AccountMeta,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  DEXTER_VAULT_PROGRAM_ID,
  DISCRIMINATORS,
  INSTRUCTIONS_SYSVAR_ID,
} from '../constants/index.js';
import {
  derivePrincipalNodePda,
  deriveGraphConfigPda,
  deriveEventAuthorityPda,
} from '../credit/derive.js';
import { deriveSwigWalletAddress } from './withdraw.js';

// ── local encoding helpers (per-file convention, matches lockedClaim.ts) ──
function encodeBytesVec(buf: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(buf.length, 0);
  return Buffer.concat([len, Buffer.from(buf)]);
}

function encodeU64(value: bigint): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(value, 0);
  return out;
}

function encodeI64(value: bigint): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigInt64LE(value, 0);
  return out;
}

function encodeU32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value, 0);
  return out;
}

function encodeBytes32(b: Uint8Array): Buffer {
  if (b.length !== 32) throw new Error('expected 32 bytes');
  return Buffer.from(b);
}

/** borsh Option<Pubkey>: 1 tag byte + 32 body iff Some. */
function encodeOptionPubkey(pk: PublicKey | null): Buffer {
  return pk ? Buffer.concat([Buffer.from([1]), pk.toBuffer()]) : Buffer.from([0]);
}

/** borsh Option<[u8;32]>: 1 tag byte + 32 body iff Some. */
function encodeOptionBytes32(b: Uint8Array | null): Buffer {
  return b ? Buffer.concat([Buffer.from([1]), encodeBytes32(b)]) : Buffer.from([0]);
}

/** borsh Option<u64>: 1 tag byte + 8 LE body iff Some. */
function encodeOptionU64(v: bigint | null): Buffer {
  return v !== null ? Buffer.concat([Buffer.from([1]), encodeU64(v)]) : Buffer.from([0]);
}

/** The on-chain RateCap struct (velocity bucket + optional hard ceiling). */
export interface RateCapInput {
  rateAmount: bigint;       // u64
  periodSecs: number;       // u32 (must be != 0 — RateCapZero)
  bucket: bigint;           // u64 initial available velocity
  lastRefill: bigint;       // i64 unix seconds
  ceiling: bigint | null;   // Option<u64> absolute outstanding ceiling
  burstMultiple: number;    // u8
}

function encodeRateCap(cap: RateCapInput): Buffer {
  return Buffer.concat([
    encodeU64(cap.rateAmount),
    encodeU32(cap.periodSecs),
    encodeU64(cap.bucket),
    encodeI64(cap.lastRefill),
    encodeOptionU64(cap.ceiling),
    Buffer.from([cap.burstMultiple & 0xff]),
  ]);
}

/**
 * The trailing (event_authority, program) pair every `#[event_cpi]` instruction
 * requires as its LAST two accounts (Anchor's emit_cpi! convention). Centralized
 * so every emitting builder appends an identical pair.
 */
function eventAccounts(): AccountMeta[] {
  const [eventAuthority] = deriveEventAuthorityPda();
  return [
    { pubkey: eventAuthority, isSigner: false, isWritable: false },
    { pubkey: DEXTER_VAULT_PROGRAM_ID, isSigner: false, isWritable: false },
  ];
}

/**
 * The authenticated ancestor chain, appended as trailing writable, non-signer
 * `remaining_accounts` (child→parent, EXCLUDING the leaf — exactly what
 * traverse_authenticated walks). `chain` comes from `walkAncestors(...).slice(1)`;
 * the GraphClient facade does that slice in ONE place (anti-bypass-drift).
 */
function chainKeys(chain: PublicKey[]): AccountMeta[] {
  return chain.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true }));
}

export function deriveStandbyBackerPda(financierSwig: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('standby-backer'), financierSwig.toBuffer()],
    DEXTER_VAULT_PROGRAM_ID,
  );
  return pda;
}

// ── open_standby ───────────────────────────────────────────────────────────

export interface OpenStandbyParams {
  vaultPda: PublicKey;
  financierSwig: PublicKey;
  cap: bigint;
  clientDataJSON: Uint8Array;
  authenticatorData: Uint8Array;
}

/**
 * Account order MUST match the on-chain struct:
 *   [0] vault               (writable)
 *   [1] financier_swig      (readonly)
 *   [2] standby_backer      (writable, PDA: ["standby-backer", financier_swig])
 *   [3] instructions_sysvar (readonly)
 * Data: disc || cap(u64) || vec(client_data_json) || vec(authenticator_data).
 */
export function buildOpenStandbyInstruction(p: OpenStandbyParams): TransactionInstruction {
  const data = Buffer.concat([
    Buffer.from(DISCRIMINATORS.open_standby),
    encodeU64(p.cap),
    encodeBytesVec(p.clientDataJSON),
    encodeBytesVec(p.authenticatorData),
  ]);
  return new TransactionInstruction({
    programId: DEXTER_VAULT_PROGRAM_ID,
    keys: [
      { pubkey: p.vaultPda, isSigner: false, isWritable: true },
      { pubkey: p.financierSwig, isSigner: false, isWritable: false },
      { pubkey: deriveStandbyBackerPda(p.financierSwig), isSigner: false, isWritable: true },
      { pubkey: INSTRUCTIONS_SYSVAR_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ── set_standby_reserve (mechanism B) ───────────────────────────────────────

export interface SetStandbyReserveParams {
  financierSwig: PublicKey;
  feePayer: PublicKey;
  newReserve: bigint;
}

/**
 * Raw set_standby_reserve instruction. MECHANISM B: this ix must be submitted as
 * the INNER CPI of the financier swig's SignV2 (see assembleStandbyReserveSignV2).
 * financier_swig_wallet_address is a struct-level Signer in the program, so its
 * meta is emitted isSigner:true here; Swig invoke_signed's the PDA at submission.
 * Account order MUST match the on-chain struct:
 *   [0] financier_swig             (readonly)
 *   [1] financier_swig_wallet_addr (SIGNER, readonly, PDA)
 *   [2] standby_backer             (writable, PDA)
 *   [3] fee_payer                  (signer, writable)
 *   [4] system_program
 * Data: disc || new_reserve(u64). NO instructions_sysvar.
 */
export function buildSetStandbyReserveInstruction(p: SetStandbyReserveParams): TransactionInstruction {
  const data = Buffer.concat([
    Buffer.from(DISCRIMINATORS.set_standby_reserve),
    encodeU64(p.newReserve),
  ]);
  return new TransactionInstruction({
    programId: DEXTER_VAULT_PROGRAM_ID,
    keys: [
      { pubkey: p.financierSwig, isSigner: false, isWritable: false },
      { pubkey: deriveSwigWalletAddress(p.financierSwig), isSigner: true, isWritable: false },
      { pubkey: deriveStandbyBackerPda(p.financierSwig), isSigner: false, isWritable: true },
      { pubkey: p.feePayer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ── close_standby (both legs) ────────────────────────────────────────────────

export interface CloseStandbyParams {
  /** 'financier' → mechanism-B (SignV2 inner CPI); 'user' → passkey precompile pair. */
  closer: 'user' | 'financier';
  vaultPda: PublicKey;
  financierSwig: PublicKey;
  clientDataJSON: Uint8Array;
  authenticatorData: Uint8Array;
}

/**
 * Raw close_standby instruction. The account list is identical for both legs
 * (the on-chain struct is shared); the leg differs only in the `closer` arg byte
 * (user=0, financier=1) and, at SUBMISSION time, the wrapping: financier =
 * mechanism-B SignV2 inner CPI (see assembleStandbyReserveSignV2; the assembler
 * patches financier_swig_wallet to signer), user = a [secp256r1 precompile,
 * close_standby{user}] pair. The raw ix emits financier_swig_wallet isSigner:false
 * (it is AccountInfo in the struct, shared by both legs).
 * Account order MUST match the on-chain struct:
 *   [0] financier_swig             (readonly)
 *   [1] financier_swig_wallet_addr (readonly, PDA)
 *   [2] vault                      (writable)
 *   [3] standby_backer             (writable, PDA)
 *   [4] instructions_sysvar        (readonly)
 * Data: disc || closer(u8) || vec(client_data_json) || vec(authenticator_data).
 */
export function buildCloseStandbyInstruction(p: CloseStandbyParams): TransactionInstruction {
  const closerByte = p.closer === 'financier' ? 1 : 0;
  const data = Buffer.concat([
    Buffer.from(DISCRIMINATORS.close_standby),
    Buffer.from([closerByte]),
    encodeBytesVec(p.clientDataJSON),
    encodeBytesVec(p.authenticatorData),
  ]);
  return new TransactionInstruction({
    programId: DEXTER_VAULT_PROGRAM_ID,
    keys: [
      { pubkey: p.financierSwig, isSigner: false, isWritable: false },
      { pubkey: deriveSwigWalletAddress(p.financierSwig), isSigner: false, isWritable: false },
      { pubkey: p.vaultPda, isSigner: false, isWritable: true },
      { pubkey: deriveStandbyBackerPda(p.financierSwig), isSigner: false, isWritable: true },
      { pubkey: INSTRUCTIONS_SYSVAR_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ── draw_credit ────────────────────────────────────────────────────────────

export interface DrawCreditParams {
  financierSwig: PublicKey;
  vaultPda: PublicKey;
  /** The drawing leaf — must equal vault.node. */
  drawingNode: PublicKey;
  /** The booked seller destination ATA — must equal the wrapped SignV2 transfer's destination. */
  sellerDestination: PublicKey;
  dexterAuthority: PublicKey;
  amount: bigint;
  recoveryWindowSeconds: bigint;
  /** The drawing leaf's authenticated ancestor chain (child→parent, EXCLUDING the
   *  leaf) — appended as trailing writable remaining_accounts. Empty for a depth-1
   *  rooted leaf (the leaf must itself be rooted). */
  chain?: PublicKey[];
}

/**
 * Account order MUST match the rebuilt on-chain struct (DrawCredit, depth-N):
 *   [0] financier_swig                (readonly)
 *   [1] financier_swig_wallet_address (readonly, PDA derived from financier_swig)
 *   [2] vault                         (readonly — credit state lives on the node now)
 *   [3] drawing_node                  (writable, == vault.node)
 *   [4] graph_config                  (readonly, PDA [b"graph_config"])
 *   [5] seller_destination            (readonly, == wrapped transfer destination)
 *   [6] dexter_authority              (signer)
 *   [7] instructions_sysvar           (readonly)
 *   [8] event_authority               (readonly, PDA [b"__event_authority"])
 *   [9] program                       (readonly, == program id)
 *   [10..] ancestor chain             (writable, child→parent, excl. leaf)
 * Data: disc || amount(u64) || recovery_window_seconds(i64).
 */
export function buildDrawCreditInstruction(p: DrawCreditParams): TransactionInstruction {
  const data = Buffer.concat([
    Buffer.from(DISCRIMINATORS.draw_credit),
    encodeU64(p.amount),
    encodeI64(p.recoveryWindowSeconds),
  ]);
  const financierSwigWalletAddress = deriveSwigWalletAddress(p.financierSwig);
  const [graphConfig] = deriveGraphConfigPda();
  return new TransactionInstruction({
    programId: DEXTER_VAULT_PROGRAM_ID,
    keys: [
      { pubkey: p.financierSwig, isSigner: false, isWritable: false },
      { pubkey: financierSwigWalletAddress, isSigner: false, isWritable: false },
      { pubkey: p.vaultPda, isSigner: false, isWritable: false },
      { pubkey: p.drawingNode, isSigner: false, isWritable: true },
      { pubkey: graphConfig, isSigner: false, isWritable: false },
      { pubkey: p.sellerDestination, isSigner: false, isWritable: false },
      { pubkey: p.dexterAuthority, isSigner: true, isWritable: false },
      { pubkey: INSTRUCTIONS_SYSVAR_ID, isSigner: false, isWritable: false },
      ...eventAccounts(),
      ...chainKeys(p.chain ?? []),
    ],
    data,
  });
}

// ── repay_credit ───────────────────────────────────────────────────────────

export interface RepayCreditParams {
  swigAddress: PublicKey;
  vaultPda: PublicKey;
  /** The drawing leaf whose `borrowed` is paid down — must equal vault.node. */
  drawingNode: PublicKey;
  dexterAuthority: PublicKey;
  amount: bigint;
  /** The drawing leaf's authenticated ancestor chain (child→parent, EXCLUDING the
   *  leaf) — the Decrement traverse lowers each ancestor's subtree_draw. */
  chain?: PublicKey[];
}

/**
 * Account order MUST match the rebuilt on-chain struct (RepayCredit, depth-N):
 *   [0] swig                (readonly, the USER's swig)
 *   [1] swig_wallet_address (readonly, PDA derived from swig)
 *   [2] vault               (readonly)
 *   [3] drawing_node        (writable, == vault.node)
 *   [4] graph_config        (readonly, PDA)
 *   [5] dexter_authority    (signer)
 *   [6] instructions_sysvar (readonly)
 *   [7] event_authority     (readonly, PDA)
 *   [8] program             (readonly)
 *   [9..] ancestor chain    (writable, child→parent, excl. leaf)
 * Data: disc || amount(u64).
 */
export function buildRepayCreditInstruction(p: RepayCreditParams): TransactionInstruction {
  const data = Buffer.concat([
    Buffer.from(DISCRIMINATORS.repay_credit),
    encodeU64(p.amount),
  ]);
  const swigWalletAddress = deriveSwigWalletAddress(p.swigAddress);
  const [graphConfig] = deriveGraphConfigPda();
  return new TransactionInstruction({
    programId: DEXTER_VAULT_PROGRAM_ID,
    keys: [
      { pubkey: p.swigAddress, isSigner: false, isWritable: false },
      { pubkey: swigWalletAddress, isSigner: false, isWritable: false },
      { pubkey: p.vaultPda, isSigner: false, isWritable: false },
      { pubkey: p.drawingNode, isSigner: false, isWritable: true },
      { pubkey: graphConfig, isSigner: false, isWritable: false },
      { pubkey: p.dexterAuthority, isSigner: true, isWritable: false },
      { pubkey: INSTRUCTIONS_SYSVAR_ID, isSigner: false, isWritable: false },
      ...eventAccounts(),
      ...chainKeys(p.chain ?? []),
    ],
    data,
  });
}

// ── seize_collateral ───────────────────────────────────────────────────────

export interface SeizeCollateralParams {
  swigAddress: PublicKey;
  vaultPda: PublicKey;
  /** The PrincipalNode being liquidated — must equal vault.node. */
  drawingNode: PublicKey;
  /** The user swig's collateral ATA (owner == swig_wallet_address). */
  collateralAta: PublicKey;
  dexterAuthority: PublicKey;
  /** The leaf's authenticated ancestor chain (child→parent, EXCLUDING the leaf). */
  chain?: PublicKey[];
}

/**
 * Account order MUST match the rebuilt on-chain struct (SeizeCollateral, depth-N):
 *   [0] swig                (readonly, the USER's swig)
 *   [1] swig_wallet_address (readonly, PDA derived from swig)
 *   [2] vault               (readonly)
 *   [3] drawing_node        (writable, == vault.node)
 *   [4] collateral_ata      (readonly)
 *   [5] graph_config        (readonly, PDA)
 *   [6] dexter_authority    (signer)
 *   [7] instructions_sysvar (readonly)
 *   [8] event_authority     (readonly, PDA)
 *   [9] program             (readonly)
 *   [10..] ancestor chain   (writable, child→parent, excl. leaf)
 * Data: discriminator only (SeizeCollateralArgs is empty).
 */
export function buildSeizeCollateralInstruction(p: SeizeCollateralParams): TransactionInstruction {
  const data = Buffer.from(DISCRIMINATORS.seize_collateral);
  const swigWalletAddress = deriveSwigWalletAddress(p.swigAddress);
  const [graphConfig] = deriveGraphConfigPda();
  return new TransactionInstruction({
    programId: DEXTER_VAULT_PROGRAM_ID,
    keys: [
      { pubkey: p.swigAddress, isSigner: false, isWritable: false },
      { pubkey: swigWalletAddress, isSigner: false, isWritable: false },
      { pubkey: p.vaultPda, isSigner: false, isWritable: false },
      { pubkey: p.drawingNode, isSigner: false, isWritable: true },
      { pubkey: p.collateralAta, isSigner: false, isWritable: false },
      { pubkey: graphConfig, isSigner: false, isWritable: false },
      { pubkey: p.dexterAuthority, isSigner: true, isWritable: false },
      { pubkey: INSTRUCTIONS_SYSVAR_ID, isSigner: false, isWritable: false },
      ...eventAccounts(),
      ...chainKeys(p.chain ?? []),
    ],
    data,
  });
}

// ── Recourse graph builders (create_node / attach / emancipate / freeze / pause /
//    seize_ancestor / init_graph_config) ───────────────────────────────────────

export interface InitGraphConfigParams {
  authority: PublicKey;        // signer + payer (rent)
  adminAuthority: PublicKey;   // cold key recorded as admin_authority
  pauseAuthority: PublicKey;   // hot key recorded as pause_authority (pause ONLY)
  maxDepthOverride?: number;   // 0 ⇒ use the MAX_DEPTH const
  usdcMint: PublicKey;         // canonical credit-settlement mint (mainnet = USDC).
                               // The recourse-out bind derives financier ATAs from this.
}

/**
 * init_graph_config (admin one-time). Order:
 *   [0] graph_config (writable, PDA) [1] authority (signer, writable) [2] system_program
 * Data: disc || admin_authority(pk) || pause_authority(pk) || max_depth_override(u8)
 *       || usdc_mint(pk).
 */
export function buildInitGraphConfigInstruction(p: InitGraphConfigParams): TransactionInstruction {
  const [graphConfig] = deriveGraphConfigPda();
  const data = Buffer.concat([
    Buffer.from(DISCRIMINATORS.init_graph_config),
    p.adminAuthority.toBuffer(),
    p.pauseAuthority.toBuffer(),
    Buffer.from([(p.maxDepthOverride ?? 0) & 0xff]),
    p.usdcMint.toBuffer(),
  ]);
  return new TransactionInstruction({
    programId: DEXTER_VAULT_PROGRAM_ID,
    keys: [
      { pubkey: graphConfig, isSigner: false, isWritable: true },
      { pubkey: p.authority, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export interface CreateNodeParams {
  nodeId: Uint8Array;           // 32-byte stable identity (PDA seed)
  controller: PublicKey;        // signer — consents to own this node
  payer: PublicKey;             // signer, writable — rent
  cap: RateCapInput;
  /** Delegate create: the PARENT node PDA. Some ⇒ parent_controller must sign +
   *  the child cap must fit under the parent's. undefined ⇒ anonymous root-less node. */
  parentNode?: PublicKey;
  /** The parent node's controller (required + signing iff parentNode is set). */
  parentController?: PublicKey;
  /** The CAPITAL source (a swig) funding this node's draws + made whole on
   *  repay/seize/cascade. ROOT-DETERMINED: for a DELEGATE it MUST equal the
   *  parent's `financier` (a tree shares ONE financier); for a root-less/
   *  operator/emancipated root it sets the tree's financier. */
  financier: PublicKey;
}

/**
 * create_node. Order (Anchor optional accounts → program id sentinel when None):
 *   [0] node (writable, PDA [b"principal", node_id])
 *   [1] controller (signer)
 *   [2] payer (signer, writable)
 *   [3] parent_node (writable | program-id sentinel)
 *   [4] parent_controller (signer | program-id sentinel)
 *   [5] graph_config (readonly, PDA)
 *   [6] system_program
 *   [7] event_authority (readonly, PDA) [8] program
 * Data: disc || node_id[32] || RateCap || Option<pubkey>(parent) || pubkey(financier).
 */
export function buildCreateNodeInstruction(p: CreateNodeParams): TransactionInstruction {
  if (p.nodeId.length !== 32) throw new Error('nodeId must be 32 bytes');
  const isDelegate = !!p.parentNode;
  if (isDelegate && !p.parentController) {
    throw new Error('create_node delegate requires parentController');
  }
  const [node] = derivePrincipalNodePda(p.nodeId);
  const [graphConfig] = deriveGraphConfigPda();
  // Anchor Option<Account> sentinel: pass the program id when the account is None.
  const parentNodeKey = p.parentNode ?? DEXTER_VAULT_PROGRAM_ID;
  const parentControllerKey = p.parentController ?? DEXTER_VAULT_PROGRAM_ID;
  const data = Buffer.concat([
    Buffer.from(DISCRIMINATORS.create_node),
    encodeBytes32(p.nodeId),
    encodeRateCap(p.cap),
    encodeOptionPubkey(p.parentNode ?? null),
    p.financier.toBuffer(),
  ]);
  return new TransactionInstruction({
    programId: DEXTER_VAULT_PROGRAM_ID,
    keys: [
      { pubkey: node, isSigner: false, isWritable: true },
      { pubkey: p.controller, isSigner: true, isWritable: false },
      { pubkey: p.payer, isSigner: true, isWritable: true },
      { pubkey: parentNodeKey, isSigner: false, isWritable: isDelegate },
      { pubkey: parentControllerKey, isSigner: isDelegate, isWritable: false },
      { pubkey: graphConfig, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ...eventAccounts(),
    ],
    data,
  });
}

export interface AttachNodeParams {
  vaultPda: PublicKey;          // writable — vault.node is set to `node`
  node: PublicKey;              // the PrincipalNode being welded to the vault
  clientDataJSON: Uint8Array;   // WebAuthn clientDataJSON (challenge = sha256(op_message))
  authenticatorData: Uint8Array;
}

/**
 * attach_node — weld a node to a vault (passkey-authorized). Order:
 *   [0] vault (writable) [1] node (readonly) [2] instructions_sysvar
 *   [3] event_authority (PDA) [4] program
 * Data: disc || vec(client_data_json) || vec(authenticator_data).
 */
export function buildAttachNodeInstruction(p: AttachNodeParams): TransactionInstruction {
  const data = Buffer.concat([
    Buffer.from(DISCRIMINATORS.attach_node),
    encodeBytesVec(p.clientDataJSON),
    encodeBytesVec(p.authenticatorData),
  ]);
  return new TransactionInstruction({
    programId: DEXTER_VAULT_PROGRAM_ID,
    keys: [
      { pubkey: p.vaultPda, isSigner: false, isWritable: true },
      { pubkey: p.node, isSigner: false, isWritable: false },
      { pubkey: INSTRUCTIONS_SYSVAR_ID, isSigner: false, isWritable: false },
      ...eventAccounts(),
    ],
    data,
  });
}

export interface AttachRootParams {
  node: PublicKey;              // writable — root_attestation is set
  nodeController: PublicKey;    // signer
  creditRoot: PublicKey;        // the CreditRoot PDA bound to [CREDIT_ROOT_SEED, nullifier]
  nullifier: Uint8Array;        // 32-byte human nullifier (CreditRoot seed component)
}

/**
 * attach_root — root a node against a human CreditRoot. Order:
 *   [0] node (writable) [1] node_controller (signer) [2] credit_root (readonly)
 *   [3] event_authority (PDA) [4] program
 * Data: disc || nullifier[32].
 */
export function buildAttachRootInstruction(p: AttachRootParams): TransactionInstruction {
  const data = Buffer.concat([
    Buffer.from(DISCRIMINATORS.attach_root),
    encodeBytes32(p.nullifier),
  ]);
  return new TransactionInstruction({
    programId: DEXTER_VAULT_PROGRAM_ID,
    keys: [
      { pubkey: p.node, isSigner: false, isWritable: true },
      { pubkey: p.nodeController, isSigner: true, isWritable: false },
      { pubkey: p.creditRoot, isSigner: false, isWritable: false },
      ...eventAccounts(),
    ],
    data,
  });
}

export interface EmancipateParams {
  node: PublicKey;              // writable — parent edge cut
  parentNode: PublicKey;        // writable — child_count decremented
  parentController: PublicKey;  // signer
  nodeController: PublicKey;    // signer
  /** The CreditRoot to acquire (when newNullifier is Some). Anchor optional →
   *  program-id sentinel when not acquiring a root. */
  creditRoot?: PublicKey;
  /** Some ⇒ acquire the human CreditRoot at [CREDIT_ROOT_SEED, N] while cutting the
   *  edge; None ⇒ cut the edge and keep any existing attestation. */
  newNullifier?: Uint8Array;
}

/**
 * emancipate — cut the parent edge (gated on zero outstanding) + optionally
 * acquire/keep a root. Order:
 *   [0] node (writable) [1] parent_node (writable) [2] parent_controller (signer)
 *   [3] node_controller (signer) [4] credit_root (readonly | sentinel)
 *   [5] graph_config (readonly) [6] event_authority (PDA) [7] program
 * Data: disc || Option<[u8;32]>(new_nullifier).
 */
export function buildEmancipateInstruction(p: EmancipateParams): TransactionInstruction {
  const [graphConfig] = deriveGraphConfigPda();
  const creditRootKey = p.creditRoot ?? DEXTER_VAULT_PROGRAM_ID;
  const data = Buffer.concat([
    Buffer.from(DISCRIMINATORS.emancipate),
    encodeOptionBytes32(p.newNullifier ?? null),
  ]);
  return new TransactionInstruction({
    programId: DEXTER_VAULT_PROGRAM_ID,
    keys: [
      { pubkey: p.node, isSigner: false, isWritable: true },
      { pubkey: p.parentNode, isSigner: false, isWritable: true },
      { pubkey: p.parentController, isSigner: true, isWritable: false },
      { pubkey: p.nodeController, isSigner: true, isWritable: false },
      { pubkey: creditRootKey, isSigner: false, isWritable: false },
      { pubkey: graphConfig, isSigner: false, isWritable: false },
      ...eventAccounts(),
    ],
    data,
  });
}

export interface SetFreezeParams {
  targetNode: PublicKey;        // writable — frozen flag set
  ancestorNode: PublicKey;      // the controlling node (self or an ancestor)
  ancestorController: PublicKey;// signer
  frozen: boolean;
}

/**
 * set_freeze — freeze/thaw a subtree. Order:
 *   [0] target_node (writable) [1] ancestor_node (readonly) [2] ancestor_controller (signer)
 *   [3] graph_config (readonly, PDA) [4] event_authority (PDA) [5] program
 * Data: disc || frozen(bool).
 */
export function buildSetFreezeInstruction(p: SetFreezeParams): TransactionInstruction {
  const [graphConfig] = deriveGraphConfigPda();
  const data = Buffer.concat([
    Buffer.from(DISCRIMINATORS.set_freeze),
    Buffer.from([p.frozen ? 1 : 0]),
  ]);
  return new TransactionInstruction({
    programId: DEXTER_VAULT_PROGRAM_ID,
    keys: [
      { pubkey: p.targetNode, isSigner: false, isWritable: true },
      { pubkey: p.ancestorNode, isSigner: false, isWritable: false },
      { pubkey: p.ancestorController, isSigner: true, isWritable: false },
      { pubkey: graphConfig, isSigner: false, isWritable: false },
      ...eventAccounts(),
    ],
    data,
  });
}

export interface SetPauseParams {
  authority: PublicKey;         // signer (admin_authority unpause/tune; pause_authority pause-only)
  paused: boolean;
  reason?: number;              // u8 opaque reason code (ignored on unpause)
}

/**
 * set_pause — flip the global pause flag. Order:
 *   [0] graph_config (writable, PDA) [1] authority (signer)
 * Data: disc || paused(bool) || reason(u8). NO event accounts (not an emit_cpi! ix).
 */
export function buildSetPauseInstruction(p: SetPauseParams): TransactionInstruction {
  const [graphConfig] = deriveGraphConfigPda();
  const data = Buffer.concat([
    Buffer.from(DISCRIMINATORS.set_pause),
    Buffer.from([p.paused ? 1 : 0]),
    Buffer.from([(p.reason ?? 0) & 0xff]),
  ]);
  return new TransactionInstruction({
    programId: DEXTER_VAULT_PROGRAM_ID,
    keys: [
      { pubkey: graphConfig, isSigner: false, isWritable: true },
      { pubkey: p.authority, isSigner: true, isWritable: false },
    ],
    data,
  });
}

export interface SeizeAncestorParams {
  ancestorSwig: PublicKey;      // the ancestor's swig — funds the cascade slice
  ancestorNode: PublicKey;      // the ancestor covering this slice (one chain hop)
  defaultedNode: PublicKey;     // writable — the defaulted leaf carrying the shortfall
  dexterAuthority: PublicKey;   // signer
  amount: bigint;               // slice of the shortfall this ancestor covers
  /** The DEFAULTED leaf's authenticated ancestor chain (child→parent, EXCLUDING the
   *  leaf). ancestorNode MUST be one of these. */
  chain?: PublicKey[];
}

/**
 * seize_ancestor (RUNG-3 cascade). Order:
 *   [0] ancestor_swig (readonly)
 *   [1] ancestor_swig_wallet_address (readonly, PDA derived from ancestor_swig)
 *   [2] ancestor_node (readonly)
 *   [3] defaulted_node (writable)
 *   [4] graph_config (readonly, PDA)
 *   [5] dexter_authority (signer)
 *   [6] instructions_sysvar (readonly)
 *   [7] event_authority (PDA) [8] program
 *   [9..] defaulted leaf's ancestor chain (writable, child→parent, excl. leaf)
 * Data: disc || amount(u64).
 */
export function buildSeizeAncestorInstruction(p: SeizeAncestorParams): TransactionInstruction {
  const ancestorSwigWalletAddress = deriveSwigWalletAddress(p.ancestorSwig);
  const [graphConfig] = deriveGraphConfigPda();
  const data = Buffer.concat([
    Buffer.from(DISCRIMINATORS.seize_ancestor),
    encodeU64(p.amount),
  ]);
  return new TransactionInstruction({
    programId: DEXTER_VAULT_PROGRAM_ID,
    keys: [
      { pubkey: p.ancestorSwig, isSigner: false, isWritable: false },
      { pubkey: ancestorSwigWalletAddress, isSigner: false, isWritable: false },
      { pubkey: p.ancestorNode, isSigner: false, isWritable: false },
      { pubkey: p.defaultedNode, isSigner: false, isWritable: true },
      { pubkey: graphConfig, isSigner: false, isWritable: false },
      { pubkey: p.dexterAuthority, isSigner: true, isWritable: false },
      { pubkey: INSTRUCTIONS_SYSVAR_ID, isSigner: false, isWritable: false },
      ...eventAccounts(),
      ...chainKeys(p.chain ?? []),
    ],
    data,
  });
}

// ── close_node ───────────────────────────────────────────────────────────────

export interface CloseNodeParams {
  /** The TERMINAL PrincipalNode being reclaimed (writable). Rent is drained to
   *  `rentRecipient`; gated by the close-safe predicate + `authority` == node.controller. */
  node: PublicKey;
  /** The welded vault — Some ONLY when a vault points at this node (vault.node == node);
   *  the handler clears vault.node so the wallet can re-open (attach_node is link-once).
   *  undefined/null ⇒ closing an orphan node (no vault points at it). */
  vault?: PublicKey | null;
  /** The parent node — Some ONLY for a delegate (node.parent == Some); its child_count
   *  is decremented (reverses create_node's increment). undefined/null ⇒ a root-less /
   *  root node with no parent edge. */
  parentNode?: PublicKey | null;
  /** Signs the close — MUST be node.controller (and, when a vault is supplied,
   *  vault.dexter_authority). For rung-0 both are the Dexter session master. */
  authority: PublicKey;
  /** Receives the reclaimed node rent (writable). DeXterR2 for rung-0. */
  rentRecipient: PublicKey;
}

/**
 * close_node — anti-griefing rent reclaim for a TERMINAL node (nothing owed, no
 * children, no default): returns its rent, un-welds the vault. Controller-gated
 * (rung-0: the Dexter session master). Order (Anchor optional accounts →
 * program-id sentinel when None, flags cleared):
 *   [0] node            (writable)
 *   [1] vault           (writable | program-id sentinel)        OPTIONAL
 *   [2] parent_node     (writable | program-id sentinel)        OPTIONAL
 *   [3] authority       (signer)
 *   [4] rent_recipient  (writable)
 *   [5] event_authority (readonly, PDA) [6] program
 * Data: discriminator only (CloseNodeArgs is empty).
 */
export function buildCloseNodeInstruction(p: CloseNodeParams): TransactionInstruction {
  const data = Buffer.from(DISCRIMINATORS.close_node);
  // Anchor Option<Account> sentinel: pass the program id when the account is None.
  const vaultKey = p.vault ?? DEXTER_VAULT_PROGRAM_ID;
  const parentNodeKey = p.parentNode ?? DEXTER_VAULT_PROGRAM_ID;
  return new TransactionInstruction({
    programId: DEXTER_VAULT_PROGRAM_ID,
    keys: [
      { pubkey: p.node, isSigner: false, isWritable: true },
      { pubkey: vaultKey, isSigner: false, isWritable: !!p.vault },
      { pubkey: parentNodeKey, isSigner: false, isWritable: !!p.parentNode },
      { pubkey: p.authority, isSigner: true, isWritable: false },
      { pubkey: p.rentRecipient, isSigner: false, isWritable: true },
      ...eventAccounts(),
    ],
    data,
  });
}

// ── migrate_v4_to_v5 ───────────────────────────────────────────────────────

export interface MigrateV4ToV5Params {
  vaultPda: PublicKey;
  dexterAuthority: PublicKey;
  payer: PublicKey;
}

/**
 * Account order MUST match the on-chain struct:
 *   [0] vault          (writable, AccountInfo validated in-handler)
 *   [1] dexter_authority (signer)
 *   [2] payer          (signer, writable)
 *   [3] system_program (readonly)
 * Data: discriminator only (MigrateV4ToV5Args is empty).
 */
export function buildMigrateV4ToV5Instruction(p: MigrateV4ToV5Params): TransactionInstruction {
  const data = Buffer.from(DISCRIMINATORS.migrate_v4_to_v5);
  return new TransactionInstruction({
    programId: DEXTER_VAULT_PROGRAM_ID,
    keys: [
      { pubkey: p.vaultPda, isSigner: false, isWritable: true },
      { pubkey: p.dexterAuthority, isSigner: true, isWritable: false },
      { pubkey: p.payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}
