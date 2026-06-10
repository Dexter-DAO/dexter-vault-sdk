/**
 * CJS-safe bs58 resolution, shared by the grant modules.
 *
 * bs58@6's CJS exports are `{ __esModule: true, default: <instance> }`, and
 * tsup/esbuild's node-mode `__toESM` re-wraps that whole object as `default`,
 * so in the emitted .cjs the instance sits TWO `.default` layers deep while
 * the ESM build needs only one (the 0.7.0 trap, same family as
 * src/instructions/swigBundle.ts). Peel layers until `.decode` AND `.encode`
 * exist — proven against the real tsup CJS artifact, not just vitest's ESM
 * path.
 */
import * as bs58Module from 'bs58';

export const bs58: { decode(s: string): Uint8Array; encode(b: Uint8Array): string } = (() => {
  let m: any = bs58Module;
  for (
    let i = 0;
    i < 3 && m && !(typeof m.decode === 'function' && typeof m.encode === 'function') && m.default;
    i += 1
  ) {
    m = m.default;
  }
  return m;
})();
