import { describe, test, expect } from 'vitest';
import * as tab from '../src/tab/index.js';

describe('./tab barrel', () => {
  test('exposes the full verb surface', () => {
    for (const name of ['openTab', 'settleTab', 'readTabMeter', 'drawCredit', 'repayCredit', 'seizeCollateral']) {
      expect(typeof (tab as any)[name]).toBe('function');
    }
  });
  test('exposes the default assembler', () => {
    expect(typeof (tab as any).defaultAssembleSignV2).toBe('function');
  });
});
