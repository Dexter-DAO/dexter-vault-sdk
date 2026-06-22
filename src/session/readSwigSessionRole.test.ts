import { describe, it, expect } from 'vitest';
import { Connection, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import {
  deriveSwigSessionRoleState,
  readSwigSessionRole,
} from './readSwigSessionRole.js';

const MASTER = '3SWJTQ4FBDveFQGQbqd8pxyBxa2PKqkega4QzxgPMWMG';
const SWIG = new PublicKey('tK5s9eEvYHnpUZ44iejM4XooWWR1kyEvvq91uN12hrG');

describe('deriveSwigSessionRoleState (pure)', () => {
  it('armed: key set and expiry in the future', () => {
    const s = deriveSwigSessionRoleState({
      sessionKeyBytes: bs58.decode(MASTER),
      expiresAtSlot: 1_000n,
      currentSlot: 400n,
    });
    expect(s.state).toBe('armed');
    expect(s.armed).toBe(true);
    expect(s.sessionKey).toBe(MASTER);
    expect(s.slotsRemaining).toBe(600n);
  });

  it('dormant: all-zeros session key (never activated)', () => {
    const s = deriveSwigSessionRoleState({
      sessionKeyBytes: new Uint8Array(32), // all zeros
      expiresAtSlot: 0n,
      currentSlot: 500n,
    });
    expect(s.state).toBe('dormant');
    expect(s.armed).toBe(false);
    expect(s.sessionKey).toBeNull();
    // 0 - 500 => negative => "re-arm now"
    expect(s.slotsRemaining <= 0n).toBe(true);
  });

  it('dormant: empty session key bytes', () => {
    const s = deriveSwigSessionRoleState({
      sessionKeyBytes: new Uint8Array(0),
      expiresAtSlot: 0n,
      currentSlot: 1n,
    });
    expect(s.state).toBe('dormant');
    expect(s.sessionKey).toBeNull();
  });

  it('expired: key set but expiry has passed', () => {
    const s = deriveSwigSessionRoleState({
      sessionKeyBytes: bs58.decode(MASTER),
      expiresAtSlot: 300n,
      currentSlot: 900n,
    });
    expect(s.state).toBe('expired');
    expect(s.armed).toBe(false);
    // expired still reports the key it WAS armed with
    expect(s.sessionKey).toBe(MASTER);
    expect(s.slotsRemaining).toBe(-600n);
  });

  it('boundary: expiresAtSlot === currentSlot is NOT armed (expired)', () => {
    const s = deriveSwigSessionRoleState({
      sessionKeyBytes: bs58.decode(MASTER),
      expiresAtSlot: 500n,
      currentSlot: 500n,
    });
    expect(s.state).toBe('expired');
    expect(s.armed).toBe(false);
    expect(s.slotsRemaining).toBe(0n);
  });
});

describe('readSwigSessionRole (wrapper with injected swig)', () => {
  const connection = new Connection('https://example.invalid');

  function fakeRole(opts: {
    sessionBased?: boolean;
    sessionKey?: Uint8Array;
    expirySlot?: bigint;
  }) {
    return {
      id: 2,
      isSessionBased: () => opts.sessionBased ?? true,
      authority: {
        signer: opts.sessionKey ?? new Uint8Array(32),
        expirySlot: opts.expirySlot ?? 0n,
      },
    };
  }

  function fakeSwig(role: any) {
    return { findRoleById: (id: number) => (id === 2 ? role : null) } as any;
  }

  it('armed role resolves with pinned current slot (no RPC)', async () => {
    const s = await readSwigSessionRole(connection, SWIG, 2, {
      _fetchSwig: (async () =>
        fakeSwig(fakeRole({ sessionKey: bs58.decode(MASTER), expirySlot: 1000n }))) as any,
      _currentSlot: 400n,
    });
    expect(s.state).toBe('armed');
    expect(s.sessionKey).toBe(MASTER);
    expect(s.expiresAtSlot).toBe(1000n);
    expect(s.currentSlot).toBe(400n);
    expect(s.slotsRemaining).toBe(600n);
  });

  it('dormant role (all-zeros key, expiry 0) resolves dormant', async () => {
    const s = await readSwigSessionRole(connection, SWIG, 2, {
      _fetchSwig: (async () => fakeSwig(fakeRole({}))) as any,
      _currentSlot: 12345n,
    });
    expect(s.state).toBe('dormant');
    expect(s.armed).toBe(false);
    expect(s.sessionKey).toBeNull();
  });

  it('throws when swig is not found', async () => {
    await expect(
      readSwigSessionRole(connection, SWIG, 2, {
        _fetchSwig: (async () => null) as any,
        _currentSlot: 1n,
      }),
    ).rejects.toThrow(/swig not found/);
  });

  it('throws when role does not exist', async () => {
    await expect(
      readSwigSessionRole(connection, SWIG, 7, {
        _fetchSwig: (async () => fakeSwig(fakeRole({}))) as any,
        _currentSlot: 1n,
      }),
    ).rejects.toThrow(/role 7 not found/);
  });

  it('throws when role is not session-based', async () => {
    await expect(
      readSwigSessionRole(connection, SWIG, 2, {
        _fetchSwig: (async () => fakeSwig(fakeRole({ sessionBased: false }))) as any,
        _currentSlot: 1n,
      }),
    ).rejects.toThrow(/not session-based/);
  });
});
