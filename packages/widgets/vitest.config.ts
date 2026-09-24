import { defineConfig } from 'vitest/config'

// Same shape as packages/sdk-react/vitest.config.ts. `setupFiles` now points at
// `test/setup.ts`, which registers Testing Library's `afterEach(cleanup)`
// and exports the shared `renderWithSnf` component-render harness every later widgets
// test file imports.
export default defineConfig({
  test: {
    name: '@sweepnflip/widgets',
    environment: 'jsdom',
    include: ['test/**/*.test.tsx', 'test/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    passWithNoTests: true,
    setupFiles: ['./test/setup.ts'],
  },
})
