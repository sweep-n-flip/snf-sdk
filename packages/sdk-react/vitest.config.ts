import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: '@sweepnflip/sdk-react',
    environment: 'jsdom',
    include: ['test/**/*.test.tsx', 'test/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    passWithNoTests: true,
  },
})
