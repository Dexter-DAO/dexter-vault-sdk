import type { DepositAddressResolver } from './types.js';

export interface DexterResolverOptions {
  /** Base URL for the Dexter API. Defaults to "https://api.dexter.cash". */
  baseUrl?: string;
  /** Injectable fetch for tests. Defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
}

/**
 * Zero-config DepositAddressResolver that POSTs to
 * /api/passkey-vault-anon/initialize and returns the
 * { swigStateAddress, receiveAddress } pair.
 *
 * The server derives swigStateAddress and receiveAddress (Swig wallet-address
 * PDA) server-side via HMAC(sessionMasterSecret, userHandle), so neither
 * secret nor HMAC logic lives in client code.
 *
 * Throws if the server omits receiveAddress — callers must never fall back
 * to swigStateAddress (depositing there strands funds).
 */
export function createDexterResolver(opts?: DexterResolverOptions): DepositAddressResolver {
  const baseUrl = opts?.baseUrl ?? 'https://api.dexter.cash';
  const fetchFn = opts?.fetch ?? globalThis.fetch;

  return async function dexterResolver(
    userHandle: Uint8Array,
  ): Promise<{ swigStateAddress: string; receiveAddress: string | null }> {
    // Encode userHandle as base64url (no padding) to match the server's parseUserHandle.
    const userHandleB64url = Buffer.from(userHandle)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const res = await fetchFn(`${baseUrl}/api/passkey-vault-anon/initialize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userHandle: userHandleB64url }),
    });

    const json = await res.json() as {
      swigStateAddress?: string;
      receiveAddress?: string | null;
      error?: string;
    };

    if (!res.ok) {
      throw new Error(
        `dexterResolver: /initialize returned HTTP ${res.status}: ${json.error ?? 'unknown'}`,
      );
    }

    if (!json.swigStateAddress) {
      throw new Error('dexterResolver: response missing swigStateAddress');
    }

    if (!json.receiveAddress) {
      throw new Error(
        'dexterResolver: response missing receiveAddress — cannot expose deposit address. ' +
          'Never substitute swigStateAddress; depositing there strands funds.',
      );
    }

    return {
      swigStateAddress: json.swigStateAddress,
      receiveAddress: json.receiveAddress,
    };
  };
}
