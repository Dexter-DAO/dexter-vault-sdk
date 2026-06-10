import { describe, it, expect } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { requestSpendGrant } from '../src/grant/request.js';
import { approveSpendGrant, GrantEditError } from '../src/grant/approve.js';
import { sessionRegisterMessage } from '../src/messages/session.js';
import { DEXTER_VAULT_PROGRAM_ID } from '../src/constants/index.js';

const VAULT = Keypair.generate().publicKey;
const SELLER = Keypair.generate().publicKey;
const FUTURE = Math.floor(Date.now() / 1000) + 7 * 86400;

function blob(extra: Record<string, unknown> = {}) {
  return requestSpendGrant({
    app: { name: 'Acme', domain: 'acme.example' },
    counterparty: SELLER.toBase58(),
    capAtomic: '5000000',
    expiresAtUnix: FUTURE,
    ...extra,
  } as any);
}

const recordingSign = () => {
  const calls: Uint8Array[] = [];
  const sign = async (msg: Uint8Array) => {
    calls.push(msg);
    return { token: 'ceremony-result' };
  };
  return { calls, sign };
};

describe('approveSpendGrant', () => {
  it('no edits: message is byte-exact vs sessionRegisterMessage on proposed values', async () => {
    const { calls, sign } = recordingSign();
    const kp = nacl.sign.keyPair();
    const approved = await approveSpendGrant({
      request: blob(),
      vaultPda: VAULT,
      nonce: 7,
      sessionKeypair: { publicKey: kp.publicKey, privateKey: kp.secretKey },
      sign,
    });
    const expected = sessionRegisterMessage({
      programId: DEXTER_VAULT_PROGRAM_ID,
      vaultPda: VAULT,
      sessionPubkey: kp.publicKey,
      maxAmount: 5000000n,
      expiresAt: BigInt(FUTURE),
      allowedCounterparty: SELLER,
      nonce: 7,
      maxRevolvingCapacity: 5000000n, // defaulted to cap
    });
    expect(Buffer.from(approved.message).equals(Buffer.from(expected))).toBe(true);
    expect(calls.length).toBe(1);
    expect(Buffer.from(calls[0]).equals(Buffer.from(expected))).toBe(true);
    expect(approved.ceremony).toEqual({ token: 'ceremony-result' });
    expect(approved.params.maxRevolvingCapacityAtomic).toBe('5000000');
    expect(approved.params.counterparty).toBe(SELLER.toBase58());
    expect(approved.shortened).toEqual({ cap: false, expiry: false });
  });

  it('shorten-only: lower cap + earlier expiry accepted; revolving clamped to final cap', async () => {
    const { sign } = recordingSign();
    const kp = nacl.sign.keyPair();
    const approved = await approveSpendGrant({
      request: blob({ revolvingCapacityAtomic: '4000000' }),
      vaultPda: VAULT,
      nonce: 1,
      sessionKeypair: { publicKey: kp.publicKey, privateKey: kp.secretKey },
      edits: { capAtomic: '2000000', expiresAtUnix: FUTURE - 86400 },
      sign,
    });
    expect(approved.params.maxAmountAtomic).toBe('2000000');
    expect(approved.params.expiresAtUnix).toBe(FUTURE - 86400);
    expect(approved.params.maxRevolvingCapacityAtomic).toBe('2000000'); // clamped ≤ final cap
    expect(approved.shortened).toEqual({ cap: true, expiry: true });
  });

  it('raise attempts throw GrantEditError', async () => {
    const { sign } = recordingSign();
    await expect(
      approveSpendGrant({
        request: blob(),
        vaultPda: VAULT,
        edits: { capAtomic: '6000000' },
        sign,
      }),
    ).rejects.toThrow(GrantEditError);
    await expect(
      approveSpendGrant({
        request: blob(),
        vaultPda: VAULT,
        edits: { expiresAtUnix: FUTURE + 1 },
        sign,
      }),
    ).rejects.toThrow(GrantEditError);
  });

  it('zero/past edits throw', async () => {
    const { sign } = recordingSign();
    await expect(
      approveSpendGrant({ request: blob(), vaultPda: VAULT, edits: { capAtomic: '0' }, sign }),
    ).rejects.toThrow(GrantEditError);
    await expect(
      approveSpendGrant({
        request: blob(),
        vaultPda: VAULT,
        edits: { expiresAtUnix: Math.floor(Date.now() / 1000) - 10 },
        sign,
      }),
    ).rejects.toThrow(GrantEditError);
  });

  it('custody (ii): blob sessionPubkey wins; returns null keypair; conflict throws', async () => {
    const { sign } = recordingSign();
    const agentKp = nacl.sign.keyPair();
    const approved = await approveSpendGrant({
      request: blob({ sessionPubkey: bs58.encode(agentKp.publicKey) }),
      vaultPda: VAULT,
      sign,
    });
    expect(approved.params.sessionPubkey).toBe(bs58.encode(agentKp.publicKey));
    expect(approved.sessionKeypair).toBeNull();

    await expect(
      approveSpendGrant({
        request: blob({ sessionPubkey: bs58.encode(agentKp.publicKey) }),
        vaultPda: VAULT,
        sessionKeypair: { publicKey: agentKp.publicKey, privateKey: agentKp.secretKey },
        sign,
      }),
    ).rejects.toThrow(/sessionPubkey/);
  });

  it('custody (i): generates an ed25519 keypair whose pubkey is in the message', async () => {
    const { calls, sign } = recordingSign();
    const approved = await approveSpendGrant({ request: blob(), vaultPda: VAULT, nonce: 3, sign });
    expect(approved.sessionKeypair).not.toBeNull();
    expect(approved.sessionKeypair!.publicKey.length).toBe(32);
    expect(approved.sessionKeypair!.privateKey.length).toBe(64);
    // pubkey occupies bytes 96..128 of the 188-byte message
    expect(Buffer.from(calls[0].slice(96, 128)).equals(Buffer.from(approved.sessionKeypair!.publicKey))).toBe(true);
    // and the generated key actually signs/verifies (it is a usable nacl keypair)
    const sig = nacl.sign.detached(new Uint8Array([1, 2, 3]), approved.sessionKeypair!.privateKey);
    expect(nacl.sign.detached.verify(new Uint8Array([1, 2, 3]), sig, approved.sessionKeypair!.publicKey)).toBe(true);
  });

  it('non-u32 nonce rejects (would silently truncate in the message bytes)', async () => {
    const { sign } = recordingSign();
    for (const nonce of [2 ** 32, -1, 1.5]) {
      await expect(
        approveSpendGrant({ request: blob(), vaultPda: VAULT, nonce, sign }),
      ).rejects.toThrow(GrantEditError);
    }
  });

  it('custody (ii): blob sessionPubkey lands byte-exact at message bytes 96..128', async () => {
    const { calls, sign } = recordingSign();
    const agentKp = nacl.sign.keyPair();
    await approveSpendGrant({
      request: blob({ sessionPubkey: bs58.encode(agentKp.publicKey) }),
      vaultPda: VAULT,
      nonce: 9,
      sign,
    });
    expect(Buffer.from(calls[0].slice(96, 128)).equals(Buffer.from(agentKp.publicKey))).toBe(true);
  });

  it('revolving above cap clamps to cap even without edits', async () => {
    const { sign } = recordingSign();
    const approved = await approveSpendGrant({
      request: blob({ revolvingCapacityAtomic: '9000000' }),
      vaultPda: VAULT,
      nonce: 4,
      sign,
    });
    expect(approved.params.maxRevolvingCapacityAtomic).toBe('5000000');
  });

  it('mismatched sessionKeypair (pubkey A, privateKey B) rejects', async () => {
    const { sign } = recordingSign();
    const a = nacl.sign.keyPair();
    const b = nacl.sign.keyPair();
    await expect(
      approveSpendGrant({
        request: blob(),
        vaultPda: VAULT,
        sessionKeypair: { publicKey: a.publicKey, privateKey: b.secretKey },
        sign,
      }),
    ).rejects.toThrow(GrantEditError);
  });

  it('defaults nonce to unix seconds when omitted', async () => {
    const { sign } = recordingSign();
    const before = Math.floor(Date.now() / 1000);
    const approved = await approveSpendGrant({ request: blob(), vaultPda: VAULT, sign });
    const after = Math.floor(Date.now() / 1000);
    expect(approved.params.nonce).toBeGreaterThanOrEqual(before);
    expect(approved.params.nonce).toBeLessThanOrEqual(after);
  });
});
