import { describe, test, expect } from 'vitest';
import { deriveCounterfactualAddresses } from '../src/counterfactual.js';

describe('counterfactual derivation', () => {
  const KNOWN_SEED   = new Uint8Array(16).fill(0x42);
  const KNOWN_HMAC   = new Uint8Array(32).fill(0x9F);

  test('known-input snapshot', async () => {
    const result = await deriveCounterfactualAddresses({
      identitySeed: KNOWN_SEED,
      hmacKey: KNOWN_HMAC,
    });
    expect(result).toMatchSnapshot();
  });

  test('same inputs → identical addresses (idempotent)', async () => {
    const a = await deriveCounterfactualAddresses({ identitySeed: KNOWN_SEED, hmacKey: KNOWN_HMAC });
    const b = await deriveCounterfactualAddresses({ identitySeed: KNOWN_SEED, hmacKey: KNOWN_HMAC });
    expect(a).toEqual(b);
  });

  test('different HMAC key → different addresses', async () => {
    const a = await deriveCounterfactualAddresses({ identitySeed: KNOWN_SEED, hmacKey: KNOWN_HMAC });
    const b = await deriveCounterfactualAddresses({
      identitySeed: KNOWN_SEED,
      hmacKey: new Uint8Array(32).fill(0xAA),
    });
    expect(a.swigStateAddress).not.toBe(b.swigStateAddress);
  });

  test('rejects empty identitySeed', async () => {
    await expect(
      deriveCounterfactualAddresses({ identitySeed: new Uint8Array(0), hmacKey: KNOWN_HMAC }),
    ).rejects.toThrow();
  });

  test('rejects HMAC key of wrong length', async () => {
    await expect(
      deriveCounterfactualAddresses({ identitySeed: KNOWN_SEED, hmacKey: new Uint8Array(16) }),
    ).rejects.toThrow();
  });
});
