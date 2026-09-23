import { defineConfig } from 'vitest/config'

// Root vitest workspace. `defineWorkspace`/`vitest.workspace.ts` (named in the plan)
// was REMOVED in Vitest 4 in favor of `test.projects` on the root config — confirmed
// against the installed vitest@5.0.1 (`vitest/config` exports no `defineWorkspace`)
// and Vitest's own v4 migration guide via Context7 this session. `test.projects`
// resolves each entry's own `vitest.config.ts`, so `packages/sdk` and
// `packages/sdk-react` keep their per-package environment/include settings.
//
// The eslint-rules RuleTester suite (Task 2) is a third, ungrouped project so it
// keeps running via a single root `vitest run` without needing its own config file.
export default defineConfig({
  test: {
    projects: [
      'packages/sdk',
      'packages/sdk-react',
      'packages/widgets',
      {
        test: {
          name: 'eslint-rules',
          environment: 'node',
          include: ['eslint-rules/__tests__/**/*.test.js'],
        },
      },
    ],
  },
})
