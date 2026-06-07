/**
 * @dexterai/vault/tab — the composed product layer over the buyer-side
 * primitives. Open a tab, stream + settle micro-charges, and (the tab that can
 * spend past the balance) draw/repay/seize credit. Every verb COMPOSES and
 * RETURNS instructions; the caller owns the transaction lifecycle.
 */
export { openTab } from './openTab.js';
export type { OpenTabParams } from './openTab.js';
export { settleTab } from './settleTab.js';
export type { SettleTabParams } from './settleTab.js';
export { readTabMeter } from './readTabMeter.js';
export type { TabMeter } from './readTabMeter.js';
export { drawCredit, repayCredit, seizeCollateral } from './credit.js';
export type { DrawCreditParams, RepayCreditParams, SeizeCollateralParams } from './credit.js';
export { defaultAssembleSignV2 } from './assembleSignV2.js';
export type { AssembleSignV2, AssembleSignV2Args } from './assembleSignV2.js';
export type { TabTransfer } from './types.js';
