import { defineConfig } from 'tsup'

// Single universal entry point, deliberately no Node-vs-browser conditional split
// (RESEARCH.md "Toolchain Research" Open Question #3). `viem` is the only peer and
// is externalised so partners' own `viem` instance is used (no duplicate bundling).
// `outExtension` is written explicitly even though tsup's default already resolves
// to `.js`/`.cjs` for a `"type": "module"` package (verified via Context7 against
// tsup's `defaultOutExtension` source) — explicit here so the mapping survives a
// future removal of `"type": "module"` from package.json without silently reverting
// to `.mjs`/`.js`, which would break the `exports` map below.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: 'es2022',
  outExtension: ({ format }) => ({ js: format === 'cjs' ? '.cjs' : '.js' }),
  external: ['viem'],
})
