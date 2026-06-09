import { describe, test, expect, vi } from 'vitest';
import { Connection, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import {
  fetchSessionAccount,
  fetchVaultSessionAccounts,
  buildSiblingAccountMetas,
  deriveSessionPda,
} from '../src/session/index.js';
import {
  SESSION_ACCOUNT_DISCRIMINATOR,
  SESSION_ACCOUNT_SIZE,
  SESSION_VAULT_OFFSET,
} from '../src/constants/index.js';

function rawSession(vault: PublicKey, counterparty: PublicKey, version: number): Buffer {
  const data = Buffer.alloc(SESSION_ACCOUNT_SIZE);
  Buffer.from(SESSION_ACCOUNT_DISCRIMINATOR).copy(data, 0);
  data.writeUInt8(version, 8);
  data.writeUInt8(255, 9);
  vault.toBuffer().copy(data, 10);
  data.writeBigInt64LE(4_000_000_000n, 82);
  counterparty.toBuffer().copy(data, 90);
  return data;
}

describe('fetchSessionAccount', () => {
  test('returns null when the PDA is absent', async () => {
    const vault = PublicKey.unique();
    const cp = PublicKey.unique();
    const conn = {
      getAccountInfo: vi.fn().mockResolvedValue(null),
    } as unknown as Connection;

    const out = await fetchSessionAccount(conn, vault, cp);
    expect(out).toBeNull();

    const [pda] = deriveSessionPda(vault, cp);
    const [calledKey, commitment] = (conn.getAccountInfo as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(calledKey.equals(pda)).toBe(true);
    expect(commitment).toBe('confirmed');
  });

  test('decodes the account when present', async () => {
    const vault = PublicKey.unique();
    const cp = PublicKey.unique();
    const conn = {
      getAccountInfo: vi.fn().mockResolvedValue({ data: rawSession(vault, cp, 1) }),
    } as unknown as Connection;

    const out = await fetchSessionAccount(conn, vault, cp);
    expect(out).not.toBeNull();
    expect(out!.session.allowedCounterparty).toBe(cp.toBase58());
    expect(out!.version).toBe(1);
  });

  test('returns a version-0 (cleared) account as-is, not null', async () => {
    const vault = PublicKey.unique();
    const cp = PublicKey.unique();
    const conn = {
      getAccountInfo: vi.fn().mockResolvedValue({ data: rawSession(vault, cp, 0) }),
    } as unknown as Connection;

    const out = await fetchSessionAccount(conn, vault, cp);
    expect(out).not.toBeNull();
    expect(out!.version).toBe(0);
  });
});

describe('fetchVaultSessionAccounts', () => {
  test('queries gPA with discriminator+vault filters and drops version==0', async () => {
    const vault = PublicKey.unique();
    const cpA = PublicKey.unique();
    const cpB = PublicKey.unique();
    const accounts = [
      { pubkey: PublicKey.unique(), account: { data: rawSession(vault, cpA, 1) } },
      { pubkey: PublicKey.unique(), account: { data: rawSession(vault, cpB, 0) } }, // cleared
    ];
    const conn = {
      getProgramAccounts: vi.fn().mockResolvedValue(accounts),
    } as unknown as Connection;

    const out = await fetchVaultSessionAccounts(conn, vault);
    expect(out).toHaveLength(1);
    expect(out[0].session.allowedCounterparty).toBe(cpA.toBase58());

    const [programId, cfg] = (conn.getProgramAccounts as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(programId.toBase58()).toBe('Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc');
    expect(cfg.filters).toEqual([
      { dataSize: SESSION_ACCOUNT_SIZE },
      { memcmp: { offset: 0, bytes: expect.any(String) } },
      { memcmp: { offset: SESSION_VAULT_OFFSET, bytes: vault.toBase58() } },
    ]);
    expect(cfg.commitment).toBe('confirmed');
  });

  test('SESSION_VAULT_OFFSET is pinned to 10 (8 disc + version u8 + bump u8)', () => {
    expect(SESSION_VAULT_OFFSET).toBe(10);
  });

  test('returns [] when gPA finds no session accounts', async () => {
    const conn = {
      getProgramAccounts: vi.fn().mockResolvedValue([]),
    } as unknown as Connection;

    const out = await fetchVaultSessionAccounts(conn, PublicKey.unique());
    expect(out).toEqual([]);
  });

  test('throws (with the row pubkey) on a wrong-size account instead of skipping it', async () => {
    const badKey = PublicKey.unique();
    const conn = {
      getProgramAccounts: vi.fn().mockResolvedValue([
        { pubkey: badKey, account: { data: Buffer.alloc(161) } },
      ]),
    } as unknown as Connection;

    const p = fetchVaultSessionAccounts(conn, PublicKey.unique());
    await expect(p).rejects.toThrow(/size/);
    await expect(p).rejects.toThrow(badKey.toBase58());
  });

  test('discriminator memcmp bytes are exactly bs58(SESSION_ACCOUNT_DISCRIMINATOR)', async () => {
    const vault = PublicKey.unique();
    const conn = {
      getProgramAccounts: vi.fn().mockResolvedValue([]),
    } as unknown as Connection;

    await fetchVaultSessionAccounts(conn, vault);

    const [, cfg] = (conn.getProgramAccounts as ReturnType<typeof vi.fn>).mock.calls[0];
    const discFilter = cfg.filters.find(
      (f: { memcmp?: { offset: number } }) => f.memcmp?.offset === 0,
    );
    expect(discFilter.memcmp.bytes).toBe(bs58.encode(SESSION_ACCOUNT_DISCRIMINATOR));
  });
});

describe('buildSiblingAccountMetas', () => {
  test('excludes the target, sorts strict-ascending by raw bytes, marks ALL writable', () => {
    const keys = Array.from({ length: 5 }, () => PublicKey.unique());
    const target = keys[2];
    const metas = buildSiblingAccountMetas(keys, target);
    expect(metas).toHaveLength(4);
    expect(metas.every((m) => m.isWritable && !m.isSigner)).toBe(true);
    expect(metas.some((m) => m.pubkey.equals(target))).toBe(false);
    for (let i = 1; i < metas.length; i++) {
      expect(Buffer.compare(metas[i - 1].pubkey.toBuffer(), metas[i].pubkey.toBuffer())).toBeLessThan(0);
    }
  });

  test('dedups an accidentally-duplicated sibling', () => {
    const k = PublicKey.unique();
    const metas = buildSiblingAccountMetas([k, k], PublicKey.unique());
    expect(metas).toHaveLength(1);
  });

  test('empty sibling list (first register) yields []', () => {
    expect(buildSiblingAccountMetas([], PublicKey.unique())).toEqual([]);
  });
});
