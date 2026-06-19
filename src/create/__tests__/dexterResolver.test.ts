import { describe, it, expect, vi } from 'vitest';
import { createDexterResolver } from '../dexterResolver.js';

const HANDLE = new Uint8Array(16).fill(0xab);

// base64url(0xab repeated 16 times) — no padding
const HANDLE_B64URL = Buffer.from(HANDLE)
  .toString('base64')
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .replace(/=+$/, '');

function mockFetch(status: number, body: unknown): typeof globalThis.fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  }) as unknown as typeof globalThis.fetch;
}

describe('createDexterResolver', () => {
  it('POSTs to the correct URL with userHandle as base64url', async () => {
    const fetchMock = mockFetch(200, {
      swigStateAddress: 'Swig111111111111111111111111111111111111111',
      receiveAddress: 'Recv111111111111111111111111111111111111111',
    });
    const resolver = createDexterResolver({ baseUrl: 'https://api.dexter.cash', fetch: fetchMock });

    await resolver(HANDLE);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.dexter.cash/api/passkey-vault-anon/initialize');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.userHandle).toBe(HANDLE_B64URL);
  });

  it('maps response swigStateAddress + receiveAddress correctly', async () => {
    const fetchMock = mockFetch(200, {
      swigStateAddress: 'Swig111111111111111111111111111111111111111',
      receiveAddress: 'Recv111111111111111111111111111111111111111',
    });
    const resolver = createDexterResolver({ baseUrl: 'https://api.dexter.cash', fetch: fetchMock });

    const result = await resolver(HANDLE);
    expect(result.swigStateAddress).toBe('Swig111111111111111111111111111111111111111');
    expect(result.receiveAddress).toBe('Recv111111111111111111111111111111111111111');
  });

  it('defaults baseUrl to https://api.dexter.cash when not specified', async () => {
    const fetchMock = mockFetch(200, {
      swigStateAddress: 'Swig111111111111111111111111111111111111111',
      receiveAddress: 'Recv111111111111111111111111111111111111111',
    });
    const resolver = createDexterResolver({ fetch: fetchMock });

    await resolver(HANDLE);

    const [url] = (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain('https://api.dexter.cash');
  });

  it('throws when receiveAddress is null/missing in the response', async () => {
    const fetchMock = mockFetch(200, {
      swigStateAddress: 'Swig111111111111111111111111111111111111111',
      receiveAddress: null,
    });
    const resolver = createDexterResolver({ baseUrl: 'https://api.dexter.cash', fetch: fetchMock });

    await expect(resolver(HANDLE)).rejects.toThrow('receiveAddress');
  });

  it('throws when receiveAddress is absent from the response', async () => {
    const fetchMock = mockFetch(200, {
      swigStateAddress: 'Swig111111111111111111111111111111111111111',
    });
    const resolver = createDexterResolver({ baseUrl: 'https://api.dexter.cash', fetch: fetchMock });

    await expect(resolver(HANDLE)).rejects.toThrow('receiveAddress');
  });

  it('throws on non-ok HTTP status', async () => {
    const fetchMock = mockFetch(404, { error: 'credential_mismatch' });
    const resolver = createDexterResolver({ baseUrl: 'https://api.dexter.cash', fetch: fetchMock });

    await expect(resolver(HANDLE)).rejects.toThrow('HTTP 404');
  });
});
