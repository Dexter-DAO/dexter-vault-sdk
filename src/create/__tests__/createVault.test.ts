import { describe, it, expect, vi, beforeEach } from 'vitest';

const { enrollMock } = vi.hoisted(() => ({ enrollMock: vi.fn() }));
vi.mock('../enroll.js', () => ({ enrollPasskey: enrollMock }));

import { createVault } from '../createVault.js';
import { deriveVaultPda } from '../../instructions/swigBundle.js';

const HANDLE = new Uint8Array(16).fill(5);

beforeEach(() => {
  enrollMock.mockReset();
  enrollMock.mockResolvedValue({
    credentialId: new Uint8Array([7, 7]),
    publicKeyBase64: 'AgAAA',
    userHandle: HANDLE,
  });
});

const resolver = vi.fn().mockResolvedValue({
  swigStateAddress: 'Swig111111111111111111111111111111111111111',
  receiveAddress: 'Recv111111111111111111111111111111111111111',
});

const cfg = { rpId: 'dexter.cash', rpName: 'Dexter', userName: 'u', resolveDepositAddress: resolver };

describe('createVault', () => {
  it('returns the full result with no on-chain write', async () => {
    const res = await createVault(cfg);
    expect(res.vaultPda).toBe(deriveVaultPda(HANDLE).pda.toBase58());
    expect(res.receiveAddress).toBe('Recv111111111111111111111111111111111111111');
    expect(res.userHandle).toBe(HANDLE);
    expect(Buffer.from(res.credentialId)).toEqual(Buffer.from([7, 7]));
    expect(enrollMock).toHaveBeenCalledTimes(1);
  });

  it('idempotent resume: with existingUserHandle it skips enrollment', async () => {
    const res = await createVault({ ...cfg, existingUserHandle: HANDLE });
    expect(enrollMock).not.toHaveBeenCalled();
    expect(res.vaultPda).toBe(deriveVaultPda(HANDLE).pda.toBase58());
    expect(res.userHandle).toBe(HANDLE);
  });

  it('propagates the receiveAddress fail-safe (null stays null)', async () => {
    resolver.mockResolvedValueOnce({ swigStateAddress: 'Swig111111111111111111111111111111111111111', receiveAddress: null });
    const res = await createVault(cfg);
    expect(res.receiveAddress).toBeNull();
  });
});
