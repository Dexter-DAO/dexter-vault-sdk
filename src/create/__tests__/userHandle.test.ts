import { describe, it, expect } from 'vitest';
import { generateUserHandle } from '../userHandle.js';

describe('generateUserHandle', () => {
  it('returns exactly 16 bytes', () => {
    expect(generateUserHandle()).toHaveLength(16);
  });
  it('returns a Uint8Array', () => {
    expect(generateUserHandle()).toBeInstanceOf(Uint8Array);
  });
  it('is non-deterministic across calls (no all-zero, distinct values)', () => {
    const a = generateUserHandle();
    const b = generateUserHandle();
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
    expect(a.some((x) => x !== 0)).toBe(true);
  });
  it('feeds deriveVaultPda without throwing (16-byte contract)', async () => {
    const { deriveVaultPda } = await import('../../instructions/swigBundle.js');
    expect(() => deriveVaultPda(generateUserHandle())).not.toThrow();
  });
});
