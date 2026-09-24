import { defineConfig } from 'tsup'

// Same dual ESM+CJS shape as packages/sdk-react/tsup.config.ts — see that file's
// header comment for the `outExtension` and single-universal-entry rationale. All
// five peers (@sweepnflip/sdk, @sweepnflip/sdk-react, react, wagmi,
// @tanstack/react-query) are externalised so the kit never bundles a second copy of
// the partner's own instances.
//
// `sideEffects: ["*.css"]` in package.json anticipates this module's theme entry point
// (a separate, non-JS `theme.css` placed into `dist/` by a sibling build step or an
// extension of this config) — that step is not built yet; this comment is the marker
// for why the package.json field is already set ahead of it.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: 'es2022',
  outExtension: ({ format }) => ({ js: format === 'cjs' ? '.cjs' : '.js' }),
  external: ['@sweepnflip/sdk', '@sweepnflip/sdk-react', 'react', 'wagmi', '@tanstack/react-query'],
})
