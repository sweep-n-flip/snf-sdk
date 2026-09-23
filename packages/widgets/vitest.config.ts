import { defineConfig } from 'vitest/config'

// Same shape as packages/sdk-react/vitest.config.ts. No `setupFiles` entry yet — that
// line (pointing at `test/setup.ts`) is added by plan 03 alongside the file itself and
// the first real test; a config referencing a not-yet-existing setup file would break
// `pnpm -r test` today.
export default defineConfig({
  test: {
    name: '@sweepnflip/widgets',
    environment: 'jsdom',
    include: ['test/**/*.test.tsx', 'test/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    passWithNoTests: true,
  },
})
