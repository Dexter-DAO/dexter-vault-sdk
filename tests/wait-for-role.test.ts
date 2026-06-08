import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { waitForRole } from '../src/instructions/registerProgramAuthority.js';

const SWIG = new PublicKey('11111111111111111111111111111112');
const fakeConnection: any = { rpcEndpoint: 'https://example.invalid' };

describe('waitForRole', () => {
  it('resolves once the swig has more than roleId roles (role becomes visible)', async () => {
    // role 3 wanted: needs roles.length >= 4. Fake returns 3 roles twice, then 4.
    let calls = 0;
    const _fetchSwig = (async () => {
      calls++;
      const n = calls >= 3 ? 4 : 3;
      return { roles: Array.from({ length: n }, () => ({})) } as any;
    });
    await waitForRole({
      connection: fakeConnection, swig: SWIG, roleId: 3,
      _fetchSwig, pollIntervalMs: 1, timeoutMs: 5000,
    });
    expect(calls).toBeGreaterThanOrEqual(3); // polled until visible
  });

  it('throws on timeout if the role never appears', async () => {
    const _fetchSwig = (async () => ({ roles: [{}, {}, {}] }) as any); // stuck at 3, role 3 never visible
    await expect(waitForRole({
      connection: fakeConnection, swig: SWIG, roleId: 3,
      _fetchSwig, pollIntervalMs: 1, timeoutMs: 30,
    })).rejects.toThrow(/not visible|timed out|timeout/i);
  });

  it('resolves immediately if the role is already visible', async () => {
    let calls = 0;
    const _fetchSwig = (async () => { calls++; return { roles: [{},{},{},{},{}] } as any; }); // 5 roles, role 3 present
    await waitForRole({ connection: fakeConnection, swig: SWIG, roleId: 3, _fetchSwig, pollIntervalMs: 1, timeoutMs: 5000 });
    expect(calls).toBe(1);
  });
});
