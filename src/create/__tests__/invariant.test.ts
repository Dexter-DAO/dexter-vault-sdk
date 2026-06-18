// Decision D: createVault performs ZERO on-chain writes. The resolver is the
// ONLY external call and it is a pure compute call (no tx). This test asserts
// createVault never reaches a Connection/sendTransaction by giving it only a
// compute resolver and asserting completion without any RPC object.
import { describe, it, expect, vi } from 'vitest';
import { createVault } from '../createVault.js';

vi.mock('../enroll.js', () => ({
  enrollPasskey: vi.fn().mockResolvedValue({
    credentialId: new Uint8Array([1]),
    publicKeyBase64: 'Ag',
    userHandle: new Uint8Array(16).fill(4),
  }),
}));

describe('Decision D — zero on-chain writes', () => {
  it('completes using only the compute resolver; no Connection/RPC is required', async () => {
    const resolver = vi.fn().mockResolvedValue({
      swigStateAddress: 'Swig111111111111111111111111111111111111111',
      receiveAddress: 'Recv111111111111111111111111111111111111111',
    });
    const res = await createVault({ rpId: 'dexter.cash', rpName: 'Dexter', userName: 'u', resolveDepositAddress: resolver });
    expect(res.receiveAddress).toBe('Recv111111111111111111111111111111111111111');
    // The resolver is the sole external dependency — no tx-sending object is involved.
    expect(resolver).toHaveBeenCalledOnce();
  });
});
