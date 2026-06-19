import { describe, it, expect, vi } from 'vitest';
import { deployVault, InsufficientFundsForDeployError } from '../deployVault.js';
import { buildSetSwigOperationMessage } from '../../messages/operations.js';

const SWIG_ADDRESS = 'Swig111111111111111111111111111111111111111';
const USER_HANDLE_B64URL = 'AAAAAAAAAAAAAAAAAAAAAA';

const FAKE_SIGNATURE = new Uint8Array(64).fill(0x01);
const FAKE_CLIENT_DATA_JSON = new Uint8Array([0x01, 0x02, 0x03]);
const FAKE_AUTHENTICATOR_DATA = new Uint8Array([0x04, 0x05, 0x06]);

function makeSigner() {
  return {
    credentialId: new Uint8Array([1, 2, 3]),
    sign: vi.fn().mockResolvedValue({
      signature: FAKE_SIGNATURE,
      clientDataJSON: FAKE_CLIENT_DATA_JSON,
      authenticatorData: FAKE_AUTHENTICATOR_DATA,
    }),
  };
}

function mockFetch(status: number, body: unknown): typeof globalThis.fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  }) as unknown as typeof globalThis.fetch;
}

describe('deployVault', () => {
  it('signs the set_swig operation message built from swigStateAddress', async () => {
    const signer = makeSigner();
    const fetchMock = mockFetch(200, {
      swigAddress: SWIG_ADDRESS,
      signature: 'txsig123',
      alreadyActive: false,
    });

    await deployVault({
      userHandle: USER_HANDLE_B64URL,
      swigStateAddress: SWIG_ADDRESS,
      signer,
      baseUrl: 'https://api.dexter.cash',
      fetch: fetchMock,
    });

    expect(signer.sign).toHaveBeenCalledTimes(1);
    const calledWith = (signer.sign.mock.calls[0] as [Uint8Array])[0];
    const expectedMsg = buildSetSwigOperationMessage(SWIG_ADDRESS);
    expect(Buffer.from(calledWith)).toEqual(Buffer.from(expectedMsg));
  });

  it('POSTs to the correct URL with base64-encoded byte fields', async () => {
    const signer = makeSigner();
    const fetchMock = mockFetch(200, {
      swigAddress: SWIG_ADDRESS,
      signature: 'txsig456',
      alreadyActive: false,
    });

    await deployVault({
      userHandle: USER_HANDLE_B64URL,
      swigStateAddress: SWIG_ADDRESS,
      signer,
      baseUrl: 'https://api.dexter.cash',
      fetch: fetchMock,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.dexter.cash/api/passkey-vault-anon/warmup');
    expect(init.method).toBe('POST');

    const body = JSON.parse(init.body as string);
    expect(body.userHandle).toBe(USER_HANDLE_B64URL);
    expect(typeof body.setSwig.clientDataJSON).toBe('string');
    expect(typeof body.setSwig.authenticatorData).toBe('string');
    expect(typeof body.setSwig.signature).toBe('string');

    // Verify they are plain base64 (not base64url — the server uses base64ToBytes)
    expect(body.setSwig.clientDataJSON).toBe(Buffer.from(FAKE_CLIENT_DATA_JSON).toString('base64'));
    expect(body.setSwig.authenticatorData).toBe(Buffer.from(FAKE_AUTHENTICATOR_DATA).toString('base64'));
    expect(body.setSwig.signature).toBe(Buffer.from(FAKE_SIGNATURE).toString('base64'));
  });

  it('returns DeployVaultResult on success', async () => {
    const signer = makeSigner();
    const fetchMock = mockFetch(200, {
      swigAddress: SWIG_ADDRESS,
      signature: 'txsig789',
      alreadyActive: false,
    });

    const result = await deployVault({
      userHandle: USER_HANDLE_B64URL,
      swigStateAddress: SWIG_ADDRESS,
      signer,
      baseUrl: 'https://api.dexter.cash',
      fetch: fetchMock,
    });

    expect(result.swigAddress).toBe(SWIG_ADDRESS);
    expect(result.signature).toBe('txsig789');
    expect(result.alreadyActive).toBe(false);
  });

  it('returns alreadyActive:true on idempotent warmup', async () => {
    const signer = makeSigner();
    const fetchMock = mockFetch(200, {
      swigAddress: SWIG_ADDRESS,
      alreadyActive: true,
    });

    const result = await deployVault({
      userHandle: USER_HANDLE_B64URL,
      swigStateAddress: SWIG_ADDRESS,
      signer,
      baseUrl: 'https://api.dexter.cash',
      fetch: fetchMock,
    });

    expect(result.alreadyActive).toBe(true);
    expect(result.signature).toBeNull();
  });

  it('throws InsufficientFundsForDeployError on 409 funds-gate', async () => {
    const signer = makeSigner();
    const fetchMock = mockFetch(409, {
      error: 'insufficient_funds_for_deploy',
      floorAtomic: '1000000',
      balanceAtomic: '0',
    });

    await expect(
      deployVault({
        userHandle: USER_HANDLE_B64URL,
        swigStateAddress: SWIG_ADDRESS,
        signer,
        baseUrl: 'https://api.dexter.cash',
        fetch: fetchMock,
      }),
    ).rejects.toThrow(InsufficientFundsForDeployError);
  });

  it('InsufficientFundsForDeployError carries floorAtomic + balanceAtomic', async () => {
    const signer = makeSigner();
    const fetchMock = mockFetch(409, {
      error: 'insufficient_funds_for_deploy',
      floorAtomic: '1000000',
      balanceAtomic: '250000',
    });

    let caught: unknown;
    try {
      await deployVault({
        userHandle: USER_HANDLE_B64URL,
        swigStateAddress: SWIG_ADDRESS,
        signer,
        baseUrl: 'https://api.dexter.cash',
        fetch: fetchMock,
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(InsufficientFundsForDeployError);
    const err = caught as InsufficientFundsForDeployError;
    expect(err.code).toBe('insufficient_funds_for_deploy');
    expect(err.floorAtomic).toBe('1000000');
    expect(err.balanceAtomic).toBe('250000');
  });

  it('throws a generic error on other non-ok HTTP responses', async () => {
    const signer = makeSigner();
    const fetchMock = mockFetch(404, { error: 'vault_not_found' });

    await expect(
      deployVault({
        userHandle: USER_HANDLE_B64URL,
        swigStateAddress: SWIG_ADDRESS,
        signer,
        baseUrl: 'https://api.dexter.cash',
        fetch: fetchMock,
      }),
    ).rejects.toThrow('HTTP 404');
  });
});
