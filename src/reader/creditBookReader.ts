/**
 * scanCreditBook — the whole-book credit read, recourse-graph edition.
 *
 * Enumerates EVERY PrincipalNode of the dexter-vault program via
 * getProgramAccounts (memcmp on the PrincipalNode discriminator at offset 0),
 * decodes each, then resolves every node to its ROOT by walking the stored
 * `parent` links (in-memory — every node is already loaded, so no extra RPC) and
 * rolls the book up PER ROOT.
 *
 * Source-of-truth by design: it reads the CHAIN, not a DB, so it surfaces every
 * credit node that actually exists — including any the DB never recorded. That is
 * the exact blindness that let a real $1 line read as $0 on 2026-06-25.
 *
 * Authoritative outstanding per root = the ROOT node's `subtree_draw` (the
 * draw/repay traversal maintains it at every node, authoritative at a ceiling-
 * root). `borrowedSum` (sum of each node's OWN `borrowed` across the subtree) is
 * carried alongside as an independent cross-check.
 */
import { Connection, PublicKey } from '@solana/web3.js';
import {
  DEXTER_VAULT_PROGRAM_ID,
  PRINCIPAL_NODE_DISCRIMINATOR_B58,
} from '../constants/index.js';
import { decodePrincipalNode } from './accountReader.js';

/** One node in the delegation graph (all USDC atomic, 6 dp). */
export interface CreditNodeRow {
  nodePda: string;
  controller: string;
  parent: string | null;
  rootPda: string;                  // resolved root node PDA (self if this is a root)
  rootAttestation: string | null;   // the root's CreditRoot attestation (null ⇒ unrooted root)
  borrowedAtomic: string;            // this node's OWN outstanding draw
  subtreeDrawAtomic: string;         // this node's rolled-up subtree draw
  ceilingAtomic: string | null;      // this node's hard ceiling (if any)
  frozen: boolean;
  depth: number;                     // hops from this node up to its root
}

/** Per-root rollup across the whole subtree it anchors. */
export interface CreditRootTotals {
  rootPda: string;
  rootAttestation: string | null;
  rooted: boolean;                   // root_attestation present
  nodeCount: number;                 // nodes in this root's subtree (incl. the root)
  outstandingAtomic: string;         // authoritative = the root's subtree_draw
  ceilingAtomic: string | null;      // the root's hard ceiling (if set)
  availableAtomic: string | null;    // max(0, ceiling - outstanding) when ceiling set
  borrowedSumAtomic: string;         // sum of each node's OWN borrowed (cross-check)
}

export interface CreditBook {
  nodes: CreditNodeRow[];
  roots: CreditRootTotals[];
  totals: {
    rootCount: number;
    nodeCount: number;
    outstandingAtomic: string;       // sum of every root's subtree_draw
  };
}

/**
 * Scan every PrincipalNode in the program and roll up the credit book per root.
 * Reads via the supplied connection's RPC (point it at the Dexter RPC).
 */
export async function scanCreditBook(
  connection: Connection,
  programId: PublicKey = DEXTER_VAULT_PROGRAM_ID,
): Promise<CreditBook> {
  const raw = await connection.getProgramAccounts(programId, {
    commitment: 'confirmed',
    filters: [
      // PrincipalNode is fixed-length, but discriminator-only is sufficient and
      // robust to layout-version size drift.
      { memcmp: { offset: 0, bytes: PRINCIPAL_NODE_DISCRIMINATOR_B58 } },
    ],
  });

  // Decode + index by PDA so the parent-link walk is pure in-memory.
  const byPda = new Map<string, ReturnType<typeof decodePrincipalNode>>();
  for (const { pubkey, account } of raw) {
    byPda.set(pubkey.toBase58(), decodePrincipalNode(account.data));
  }

  // Resolve each node's root (parent-link walk, cycle-guarded) + its depth.
  function resolveRoot(startPda: string): { rootPda: string; depth: number } {
    let current = startPda;
    let depth = 0;
    const seen = new Set<string>();
    for (;;) {
      if (seen.has(current)) break; // cycle guard — treat current as the terminus
      seen.add(current);
      const node = byPda.get(current);
      if (!node || node.parent === null) return { rootPda: current, depth };
      current = node.parent;
      depth += 1;
    }
    return { rootPda: current, depth };
  }

  const nodes: CreditNodeRow[] = [];
  for (const [nodePda, node] of byPda) {
    const { rootPda, depth } = resolveRoot(nodePda);
    const root = byPda.get(rootPda);
    nodes.push({
      nodePda,
      controller: node.controller,
      parent: node.parent,
      rootPda,
      rootAttestation: root?.rootAttestation ?? null,
      borrowedAtomic: node.borrowed,
      subtreeDrawAtomic: node.subtreeDraw,
      ceilingAtomic: node.cap.ceiling,
      frozen: node.frozen,
      depth,
    });
  }

  // Per-root rollup.
  const rootMap = new Map<string, CreditRootTotals>();
  for (const row of nodes) {
    let agg = rootMap.get(row.rootPda);
    if (!agg) {
      const root = byPda.get(row.rootPda);
      const outstanding = root ? root.subtreeDraw : '0';
      const ceiling = root?.cap.ceiling ?? null;
      const available =
        ceiling !== null
          ? (BigInt(ceiling) > BigInt(outstanding) ? BigInt(ceiling) - BigInt(outstanding) : 0n).toString()
          : null;
      agg = {
        rootPda: row.rootPda,
        rootAttestation: root?.rootAttestation ?? null,
        rooted: !!root?.rootAttestation,
        nodeCount: 0,
        outstandingAtomic: outstanding,
        ceilingAtomic: ceiling,
        availableAtomic: available,
        borrowedSumAtomic: '0',
      };
      rootMap.set(row.rootPda, agg);
    }
    agg.nodeCount += 1;
    agg.borrowedSumAtomic = (BigInt(agg.borrowedSumAtomic) + BigInt(row.borrowedAtomic)).toString();
  }

  const roots = [...rootMap.values()].sort((a, b) => {
    const d = BigInt(b.outstandingAtomic) - BigInt(a.outstandingAtomic);
    if (d !== 0n) return d > 0n ? 1 : -1;
    return a.rootPda < b.rootPda ? -1 : a.rootPda > b.rootPda ? 1 : 0;
  });

  let outstanding = 0n;
  for (const r of roots) outstanding += BigInt(r.outstandingAtomic);

  return {
    nodes,
    roots,
    totals: {
      rootCount: roots.length,
      nodeCount: nodes.length,
      outstandingAtomic: outstanding.toString(),
    },
  };
}
