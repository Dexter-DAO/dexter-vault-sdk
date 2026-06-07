import { defineConfig } from 'tsup';
import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export default defineConfig({
  entry: {
    'index': 'src/index.ts',
    'types': 'src/types.ts',
    'counterfactual': 'src/counterfactual.ts',
    'constants/index': 'src/constants/index.ts',
    'factoring/index': 'src/factoring/index.ts',
    'instructions/index': 'src/instructions/index.ts',
    'kit/index': 'src/kit/index.ts',
    'messages/index': 'src/messages/index.ts',
    'reader/index': 'src/reader/index.ts',
    'precompile/index': 'src/precompile/index.ts',
    'signers/types': 'src/signers/types.ts',
    'signers/node/index': 'src/signers/node/index.ts',
    'signers/browser/index': 'src/signers/browser/index.ts',
    'tab/index': 'src/tab/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  minify: false,
  splitting: false,
  sourcemap: false,
  target: 'es2022',
  external: [
    '@solana/web3.js',
    '@solana/spl-token',
    '@swig-wallet/kit',
    '@swig-wallet/lib',
  ],
  async onSuccess() {
    // Ship src/idl/*.json as raw assets under dist/idl/ for downstream
    // tooling that needs the IDL without going through the JS bundle
    // (verify scripts, audit tools, IETF I-D citations).
    await mkdir(join(__dirname, 'dist', 'idl'), { recursive: true });
    await copyFile(
      join(__dirname, 'src', 'idl', 'dexter_vault.json'),
      join(__dirname, 'dist', 'idl', 'dexter_vault.json'),
    );
  },
});
