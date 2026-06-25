/**
 * scanCreditBook — the whole-book credit read.
 *
 * Enumerates EVERY vault of the dexter-vault program via getProgramAccounts
 * (memcmp on the Vault account discriminator at offset 0), decodes each with the
 * authoritative reader, and returns only the vaults carrying a standby backer
 * (an open credit line) plus aggregate totals.
 *
 * Source-of-truth by design: it reads the CHAIN, not a DB, so it surfaces every
 * credit vault that actually exists — including any the DB never recorded. That
 * is the exact blindness that let a real $1 line read as $0 on 2026-06-25: no
 * tool could answer "show me our credit book." This is that tool.
 *
 * Vault is VARIABLE-LENGTH (pending_withdrawal + standby_backer Options), so
 * there is NO dataSize gPA filter — we decode each account and filter in code.
 * Pool funding (the financier's USDC balance) is an orthogonal read the caller
 * overlays; this returns the on-chain credit book (promised vs drawn), which is
 * what `vault.borrowed`/`standby_cap` make authoritative.
 */
import { Connection, PublicKey } from '@solana/web3.js';
import {
  DEXTER_VAULT_PROGRAM_ID,
  VAULT_ACCOUNT_DISCRIMINATOR_B58,
} from '../constants/index.js';
import { decodeVaultFull } from './accountReader.js';

/** One credit vault's line, drawn, and headroom (all USDC atomic, 6 dp). */
export interface CreditBookRow {
  vaultPda: string;
  swigAddress: string | null;
  standbyBacker: string; // financier swig — non-null by construction (filtered)
  standbyCapAtomic: string; // line size
  borrowedAtomic: string; // currently drawn (authoritative on-chain debt)
  availableAtomic: string; // max(0, cap - borrowed)
  borrowRecoveryAt: number | null;
}

/** Per-financier rollup across the vaults it backs. */
export interface CreditBackerTotals {
  backer: string;
  vaultCount: number;
  promisedAtomic: string;
  drawnAtomic: string;
}

export interface CreditBook {
  rows: CreditBookRow[];
  totals: {
    vaultCount: number; // vaults WITH an open line
    promisedAtomic: string; // sum of caps
    drawnAtomic: string; // sum of borrowed
    availableAtomic: string; // sum of available
    byBacker: CreditBackerTotals[];
  };
}

/**
 * Scan every credit vault in the program. Reads via the supplied connection's
 * RPC (point it at the Dexter RPC). Returns vaults with an open line + totals.
 */
export async function scanCreditBook(
  connection: Connection,
  programId: PublicKey = DEXTER_VAULT_PROGRAM_ID,
): Promise<CreditBook> {
  const raw = await connection.getProgramAccounts(programId, {
    commitment: 'confirmed',
    filters: [
      // Vault is VARIABLE-LENGTH (Option fields) → discriminator only, no dataSize.
      { memcmp: { offset: 0, bytes: VAULT_ACCOUNT_DISCRIMINATOR_B58 } },
    ],
  });

  const rows: CreditBookRow[] = [];
  for (const { pubkey, account } of raw) {
    const v = decodeVaultFull(account.data);
    if (!v.exists || !v.standbyBacker) continue; // only vaults with an open line
    const cap = BigInt(v.standbyCap);
    const borrowed = BigInt(v.borrowed);
    const available = cap > borrowed ? cap - borrowed : 0n;
    rows.push({
      vaultPda: pubkey.toBase58(),
      swigAddress: v.swigAddress,
      standbyBacker: v.standbyBacker,
      standbyCapAtomic: cap.toString(),
      borrowedAtomic: borrowed.toString(),
      availableAtomic: available.toString(),
      borrowRecoveryAt: v.borrowRecoveryAt,
    });
  }

  // Largest line first, then by vault pubkey for a deterministic order.
  rows.sort((a, b) => {
    const d = BigInt(b.standbyCapAtomic) - BigInt(a.standbyCapAtomic);
    if (d !== 0n) return d > 0n ? 1 : -1;
    return a.vaultPda < b.vaultPda ? -1 : a.vaultPda > b.vaultPda ? 1 : 0;
  });

  let promised = 0n;
  let drawn = 0n;
  let available = 0n;
  const backerMap = new Map<string, { count: number; promised: bigint; drawn: bigint }>();
  for (const r of rows) {
    const cap = BigInt(r.standbyCapAtomic);
    const bor = BigInt(r.borrowedAtomic);
    promised += cap;
    drawn += bor;
    available += BigInt(r.availableAtomic);
    const agg = backerMap.get(r.standbyBacker) ?? { count: 0, promised: 0n, drawn: 0n };
    agg.count += 1;
    agg.promised += cap;
    agg.drawn += bor;
    backerMap.set(r.standbyBacker, agg);
  }

  const byBacker: CreditBackerTotals[] = [...backerMap.entries()].map(([backer, a]) => ({
    backer,
    vaultCount: a.count,
    promisedAtomic: a.promised.toString(),
    drawnAtomic: a.drawn.toString(),
  }));

  return {
    rows,
    totals: {
      vaultCount: rows.length,
      promisedAtomic: promised.toString(),
      drawnAtomic: drawn.toString(),
      availableAtomic: available.toString(),
      byBacker,
    },
  };
}
