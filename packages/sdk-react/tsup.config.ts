import { defineConfig } from 'tsup'

// Same dual ESM+CJS shape as packages/sdk/tsup.config.ts — see that file's header
// comment for the `outExtension` and single-universal-entry rationale. All peers
// (viem, wagmi, @tanstack/react-query, react, @sweepnflip/sdk) are externalised so
// the adapter never bundles a second copy of the partner's own instances.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: 'es2022',
  outExtension: ({ format }) => ({ js: format === 'cjs' ? '.cjs' : '.js' }),
  external: ['viem', 'wagmi', '@tanstack/react-query', 'react', '@sweepnflip/sdk'],
})
