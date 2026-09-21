import { defineConfig } from 'vitest/config'

// `test/fork/**` is excluded from the default `vitest run` so no invocation of this
// config ever tries to spawn anvil — the fork lane (plan 18) gets its own
// `vitest.fork.config.ts` and its own `test:fork` script (see root package.json;
// this plan only reserves the script name, per Task 3's action text).
export default defineConfig({
  test: {
    name: '@sweepnflip/sdk',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['test/fork/**', 'node_modules/**', 'dist/**'],
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
    },
  },
})
