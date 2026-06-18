import { describe, it, expect, vi } from 'vitest';
import { resolveVaultAddresses } from '../deriveAddresses.js';
import { deriveVaultPda } from '../../instructions/swigBundle.js';

const HANDLE = new Uint8Array(16).fill(3);

describe('resolveVaultAddresses', () => {
  it('derives the vault PDA client-side (matches deriveVaultPda) and passes through the resolver address', async () => {
    const resolver = vi.fn().mockResolvedValue({
      swigStateAddress: 'Swig111111111111111111111111111111111111111',
      receiveAddress: 'Recv111111111111111111111111111111111111111',
    });
    const out = await resolveVaultAddresses(HANDLE, resolver);
    expect(out.vaultPda).toBe(deriveVaultPda(HANDLE).pda.toBase58());
    expect(out.swigStateAddress).toBe('Swig111111111111111111111111111111111111111');
    expect(out.receiveAddress).toBe('Recv111111111111111111111111111111111111111');
    expect(resolver).toHaveBeenCalledWith(HANDLE);
  });

  it('FAIL-SAFE: never falls back to swigStateAddress when receiveAddress is null', async () => {
    const resolver = vi.fn().mockResolvedValue({
      swigStateAddress: 'Swig111111111111111111111111111111111111111',
      receiveAddress: null,
    });
    const out = await resolveVaultAddresses(HANDLE, resolver);
    expect(out.receiveAddress).toBeNull();
    expect(out.receiveAddress).not.toBe(out.swigStateAddress);
  });

  it('rejects a non-16-byte handle (deriveVaultPda contract)', async () => {
    const resolver = vi.fn();
    await expect(resolveVaultAddresses(new Uint8Array(8), resolver)).rejects.toThrow();
    expect(resolver).not.toHaveBeenCalled();
  });
});
