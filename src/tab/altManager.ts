/**
 * altManager — per-root Address Lookup Table machinery so a DEEP recourse draw
 * (root + the whole authenticated ancestor chain + the fixed credit accounts)
 * still fits a single v0 transaction. A legacy tx caps at ~35 distinct accounts;
 * a depth-8 draw blows past that. An ALT collapses each address to a 1-byte
 * index, so the chain rides along cheaply.
 *
 * SDK convention: this RETURNS instructions (+ the derived ALT address); it does
 * NOT sign or send. The caller (the facilitator, Task 14) signs with the ALT
 * authority + payer and submits. A per-root ALT is durable: create it once for a
 * root's lineage, then every draw under that root references the same table.
 *
 * NOTE (decision, Task 13): the LIVE "does a depth-8 draw actually fit one tx /
 * how many CUs" measurement is the e2e's job (Task 15 — it needs a validator).
 * This module builds the ALT plumbing; the e2e proves it on-chain.
 */
import {
  AddressLookupTableProgram,
  Connection,
  PublicKey,
  TransactionInstruction,
} from '@solana/web3.js';

export interface EnsureRootAltOptions {
  /** The ALT authority (may extend/close the table). Must sign create + extend. */
  authority: PublicKey;
  /** Rent + fee payer for create/extend. Must sign. Defaults to `authority`. */
  payer?: PublicKey;
  /** An already-created ALT for this root (the caller's root→ALT mapping). When
   *  given, ensureRootAlt fetches it and returns ONLY the extend ixs for any
   *  addresses still missing (idempotent top-up). */
  existingAlt?: PublicKey;
  /** Extra fixed accounts to fold into the table (e.g. graph_config, the
   *  event_authority PDA, dexter_authority, the financier swig + wallet). */
  extraAddresses?: PublicKey[];
}

export interface EnsureRootAltResult {
  /** The lookup table address (derived deterministically on create, or echoed). */
  altAddress: PublicKey;
  /** create (+ extend) instructions, or extend-only when topping up an existing ALT.
   *  Empty when an existing ALT already covers every address. */
  instructions: TransactionInstruction[];
  /** true when a fresh table is being created (the create ix is included). */
  createdNew: boolean;
  /** The addresses this call adds to the table. */
  addedAddresses: PublicKey[];
}

const MAX_EXTEND_PER_IX = 30; // conservative: ~38 pubkeys fit in one extend tx

function dedupe(addresses: PublicKey[]): PublicKey[] {
  const seen = new Set<string>();
  const out: PublicKey[] = [];
  for (const a of addresses) {
    const k = a.toBase58();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(a);
  }
  return out;
}

/**
 * Ensure a per-root Address Lookup Table exists and covers the root's lineage.
 *
 * @param connection RPC.
 * @param rootPda    The root node PDA — the logical key for this table (also folded in).
 * @param chain      The authenticated ancestor chain (the PrincipalNode PDAs to fold in).
 * @param opts       authority/payer + optional existing ALT + extra fixed accounts.
 */
export async function ensureRootAlt(
  connection: Connection,
  rootPda: PublicKey,
  chain: PublicKey[],
  opts: EnsureRootAltOptions,
): Promise<EnsureRootAltResult> {
  const payer = opts.payer ?? opts.authority;
  const wanted = dedupe([rootPda, ...chain, ...(opts.extraAddresses ?? [])]);

  // ── top-up path: an ALT already exists for this root ──────────────────────
  if (opts.existingAlt) {
    const fetched = await connection.getAddressLookupTable(opts.existingAlt);
    const present = new Set(
      (fetched.value?.state.addresses ?? []).map((a) => a.toBase58()),
    );
    const missing = wanted.filter((a) => !present.has(a.toBase58()));
    const instructions: TransactionInstruction[] = [];
    for (let i = 0; i < missing.length; i += MAX_EXTEND_PER_IX) {
      instructions.push(
        AddressLookupTableProgram.extendLookupTable({
          payer,
          authority: opts.authority,
          lookupTable: opts.existingAlt,
          addresses: missing.slice(i, i + MAX_EXTEND_PER_IX),
        }),
      );
    }
    return { altAddress: opts.existingAlt, instructions, createdNew: false, addedAddresses: missing };
  }

  // ── create path: derive a fresh ALT off a recent slot, then extend ────────
  // Use 'confirmed', NOT 'finalized'. The ALT program requires recentSlot to be
  // in the recent SlotHashes window; a finalized slot lags the processed tip and
  // is rejected as "<slot> is not a recent slot" (proven by the program e2e Test
  // C). 'confirmed' tracks the tip closely and is always a real, recent slot.
  // The returned create instruction must be submitted promptly (or re-derived).
  const recentSlot = await connection.getSlot('confirmed');
  const [createIx, altAddress] = AddressLookupTableProgram.createLookupTable({
    authority: opts.authority,
    payer,
    recentSlot,
  });
  const instructions: TransactionInstruction[] = [createIx];
  for (let i = 0; i < wanted.length; i += MAX_EXTEND_PER_IX) {
    instructions.push(
      AddressLookupTableProgram.extendLookupTable({
        payer,
        authority: opts.authority,
        lookupTable: altAddress,
        addresses: wanted.slice(i, i + MAX_EXTEND_PER_IX),
      }),
    );
  }
  return { altAddress, instructions, createdNew: true, addedAddresses: wanted };
}
