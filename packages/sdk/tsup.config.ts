import { defineConfig } from 'tsup'

// Two entry points, deliberately no Node-vs-browser conditional split.
// `viem` is the only peer and is externalised
// so partners' own `viem` instance is used (no duplicate bundling). `outExtension` is
// written explicitly even though tsup's default already resolves to `.js`/`.cjs` for
// a `"type": "module"` package (verified via Context7 against tsup's
// `defaultOutExtension` source) — explicit here so the mapping survives a future
// removal of `"type": "module"` from package.json without silently reverting to
// `.mjs`/`.js`, which would break the `exports` map below.
//
// `checkout` is a SECOND
// entry pointing at the already-written, already-tested `src/checkout/index.ts`
// — no file under `src/` is touched or created by this addition, only this
// build config and `package.json`'s `exports` map. `createCheckout(plan)` is
// `@sweepnflip/sdk-react`'s ONE dispatch-site dependency: the reducer
// that structurally cannot produce a dispatch effect from a watcher path
// lives in the core on purpose, and the adapter needs to actually import it rather
// than re-implement the state machine. `createCheckout` was deliberately left off the
// main barrel (`src/index.ts`) because it isn't one of `SnfClient`'s 13 documented
// methods — but "not on the main barrel" and "unreachable from any package" are
// different things, and the latter was never the intent: it is
// consumed by `@sweepnflip/sdk-react`'s `useSnfCheckout`, a different entry
// point. This subpath is that different entry point.
export default defineConfig({
  entry: { index: 'src/index.ts', checkout: 'src/checkout/index.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: 'es2022',
  outExtension: ({ format }) => ({ js: format === 'cjs' ? '.cjs' : '.js' }),
  external: ['viem'],
})
