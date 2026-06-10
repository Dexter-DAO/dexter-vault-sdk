import { describe, it, expect } from 'vitest';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import {
  requestSpendGrant,
  parseSpendGrantRequest,
  encodeSpendGrantRequest,
  decodeSpendGrantRequest,
  SpendGrantValidationError,
} from '../src/grant/request.js';

const SELLER = Keypair.generate().publicKey.toBase58();
const SESSION_PK = Keypair.generate().publicKey.toBase58();
const FUTURE = Math.floor(Date.now() / 1000) + 7 * 86400;

function baseArgs() {
  return {
    app: { name: 'Acme Research', domain: 'acme.example' },
    counterparty: SELLER,
    capAtomic: '5000000',
    expiresAtUnix: FUTURE,
  };
}

describe('requestSpendGrant', () => {
  it('builds a v1 blob with kind + defaults', () => {
    const blob = requestSpendGrant(baseArgs());
    expect(blob.v).toBe(1);
    expect(blob.kind).toBe('dexter.spendGrantRequest');
    expect(blob.counterparty).toBe(SELLER);
    expect(blob.proposed.capAtomic).toBe('5000000');
    expect(blob.proposed.expiresAtUnix).toBe(FUTURE);
    expect(blob.proposed.revolvingCapacityAtomic).toBeUndefined();
    expect(blob.sessionPubkey).toBeUndefined();
  });

  it('carries optional sessionPubkey, requestId, callback, revolving', () => {
    const blob = requestSpendGrant({
      ...baseArgs(),
      revolvingCapacityAtomic: '1000000',
      sessionPubkey: SESSION_PK,
      requestId: 'req-1',
      callback: { url: 'https://acme.example/granted', method: 'redirect' },
    });
    expect(blob.sessionPubkey).toBe(SESSION_PK);
    expect(blob.proposed.revolvingCapacityAtomic).toBe('1000000');
    expect(blob.callback?.method).toBe('redirect');
  });

  it('rejects non-base58-32 counterparty', () => {
    expect(() => requestSpendGrant({ ...baseArgs(), counterparty: 'not-a-key' }))
      .toThrow(SpendGrantValidationError);
  });

  it('rejects zero / non-integer / oversized cap', () => {
    expect(() => requestSpendGrant({ ...baseArgs(), capAtomic: '0' })).toThrow(SpendGrantValidationError);
    expect(() => requestSpendGrant({ ...baseArgs(), capAtomic: '1.5' })).toThrow(SpendGrantValidationError);
    expect(() => requestSpendGrant({ ...baseArgs(), capAtomic: '18446744073709551616' }))
      .toThrow(SpendGrantValidationError); // u64::MAX + 1
  });

  it('rejects past expiry and zero revolving', () => {
    expect(() => requestSpendGrant({ ...baseArgs(), expiresAtUnix: 1000 })).toThrow(SpendGrantValidationError);
    expect(() => requestSpendGrant({ ...baseArgs(), revolvingCapacityAtomic: '0' }))
      .toThrow(SpendGrantValidationError);
  });

  it('rejects non-https callback and iconUrl', () => {
    expect(() =>
      requestSpendGrant({ ...baseArgs(), callback: { url: 'http://x.example/cb', method: 'post' } }),
    ).toThrow(SpendGrantValidationError);
    expect(() =>
      requestSpendGrant({ ...baseArgs(), app: { name: 'A', domain: 'a.example', iconUrl: 'javascript:x' } }),
    ).toThrow(SpendGrantValidationError);
  });
});

describe('parseSpendGrantRequest (untrusted input)', () => {
  it('round-trips a valid blob from JSON string and from object', () => {
    const blob = requestSpendGrant(baseArgs());
    expect(parseSpendGrantRequest(JSON.stringify(blob))).toEqual(blob);
    expect(parseSpendGrantRequest(JSON.parse(JSON.stringify(blob)))).toEqual(blob);
  });

  it('rejects wrong kind / version / garbage', () => {
    expect(() => parseSpendGrantRequest('not json')).toThrow(SpendGrantValidationError);
    expect(() => parseSpendGrantRequest({})).toThrow(SpendGrantValidationError);
    expect(() => parseSpendGrantRequest({ v: 2, kind: 'dexter.spendGrantRequest' }))
      .toThrow(SpendGrantValidationError);
    expect(() => parseSpendGrantRequest({ v: 1, kind: 'other' })).toThrow(SpendGrantValidationError);
  });

  it('strips unknown fields (output contains only schema fields)', () => {
    const blob: any = JSON.parse(JSON.stringify(requestSpendGrant(baseArgs())));
    blob.injected = 'evil';
    blob.app.injected = 'evil';
    const parsed: any = parseSpendGrantRequest(blob);
    expect(parsed.injected).toBeUndefined();
    expect(parsed.app.injected).toBeUndefined();
  });

  it('rejects oversized display strings', () => {
    const blob: any = JSON.parse(JSON.stringify(requestSpendGrant(baseArgs())));
    blob.app.name = 'x'.repeat(65);
    expect(() => parseSpendGrantRequest(blob)).toThrow(SpendGrantValidationError);
  });
});

describe('encode/decode (URL transport)', () => {
  it('base64url round-trip', () => {
    const blob = requestSpendGrant({ ...baseArgs(), sessionPubkey: SESSION_PK });
    const encoded = encodeSpendGrantRequest(blob);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/); // no +, /, =
    expect(decodeSpendGrantRequest(encoded)).toEqual(blob);
  });
});
