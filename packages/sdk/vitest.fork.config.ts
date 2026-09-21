import { defineConfig } from 'vitest/config'

// The separate fork-lane project (plan 18, R20). `test/fork/**` is EXCLUDED from the
// default `vitest.config.ts` — this config exists so `pnpm test:fork` is the only
// invocation that ever spawns anvil. Longer timeouts (anvil startup + a real fork
// RPC round trip is slower than the mocked unit suite); `pool: 'forks'` with
// `singleFork: true` so only one anvil runs at a time locally (CI parallelises
// across matrix jobs instead — see `.github/workflows/ci.yml`'s `fork` job).
export default defineConfig({
  test: {
    name: '@sweepnflip/sdk:fork',
    environment: 'node',
    include: ['test/fork/**/*.fork.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    passWithNoTests: true,
    pool: 'forks',
    // Vitest 5 moved `poolOptions.forks.singleFork` to a top-level option; disabling
    // file parallelism keeps the same intent (one anvil process at a time locally —
    // CI parallelises across matrix jobs instead, never within one process).
    fileParallelism: false,
  },
})
