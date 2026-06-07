/**
 * Back-compat shim. The bridge helper now lives in ../kit (single home).
 * Kept so existing `./factoring/kitBridge.js` imports keep working; new code
 * should import from `@dexterai/vault/kit`.
 */
export { kitInstructionsToWeb3, getRpc } from '../kit/index.js';
