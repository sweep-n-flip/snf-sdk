import tseslint from 'typescript-eslint'

import local from './eslint-rules/index.js'

// Flat ESLint 9 config. `local` is a virtual, repo-only plugin (no publish step —
// see https://eslint.org/docs/latest/use/configure/plugins#virtual-plugins) exposing
// the three rules that make SPEC prohibitions #1 and #5 machine-checkable.
export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', 'examples/next-app/.next/**'],
  },

  // Type-checked TS linting for the published package sources only. typescript-eslint
  // v8's `projectService` auto-discovers each file's nearest tsconfig.json — no manual
  // per-package `project` array needed in this monorepo (verified via Context7 against
  // typescript-eslint's own Monorepos troubleshooting doc this session).
  {
    files: ['packages/*/src/**/*.ts', 'packages/*/src/**/*.tsx'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // CLAUDE.md: no `any`.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },

  // SPEC prohibition #1 — core only: no signing surfaces, no module-global state.
  {
    files: ['packages/sdk/src/**/*.ts'],
    plugins: { local },
    rules: {
      'local/no-signing-imports': 'error',
      'local/no-module-global-state': 'error',
    },
  },

  // SPEC prohibition #5 — both packages: no SnF backend calls, no third-party
  // keys, no process.env reads, no import outside the allowed surface.
  {
    files: ['packages/*/src/**/*.ts', 'packages/*/src/**/*.tsx'],
    plugins: { local },
    rules: {
      'local/no-snf-backend': 'error',
    },
  },

  // The sdk-react adapter is the ONLY dispatch site — useSnfCheckout sends via
  // wagmi sendTransaction/writeContract when the user clicks next(). It legitimately
  // touches wagmi's WalletClient-adjacent surface, so no-signing-imports is off here;
  // its own no-auto-advance discipline is enforced by
  // test/prohibitions/no-auto-advance.test.ts, not by this lint rule.
  {
    files: ['packages/sdk-react/src/**/*.ts', 'packages/sdk-react/src/**/*.tsx'],
    plugins: { local },
    rules: {
      'local/no-signing-imports': 'off',
    },
  },

  // Widgets only: the five mechanical guards keeping
  // trading logic out of the kit. no-signing-imports is the repository's existing
  // rule (SPEC prohibition #1), switched ON here rather than rewritten — neither the
  // sdk-only ON block above nor the sdk-react OFF block reaches this package's source,
  // so without this explicit ON the rule would simply never run against the widgets
  // glob below at all. The other four are new, widgets-specific rules: no direct
  // contract read/write (no-contract-calls), no arithmetic on an Amount.value
  // (no-amount-arithmetic), no numeric reformatting (no-numeric-formatting), no
  // next() dispatch from a useEffect (no-effect-dispatch).
  {
    files: ['packages/widgets/src/**/*.ts', 'packages/widgets/src/**/*.tsx'],
    plugins: { local },
    rules: {
      'local/no-signing-imports': 'error',
      'local/no-contract-calls': 'error',
      'local/no-amount-arithmetic': 'error',
      'local/no-numeric-formatting': 'error',
      'local/no-effect-dispatch': 'error',
    },
  },

  // Examples, scripts and the rule files themselves legitimately read
  // process.env and send transactions — none of them ship in the published package.
  {
    files: ['examples/**', 'scripts/**', 'eslint-rules/**'],
    plugins: { local },
    rules: {
      'local/no-signing-imports': 'off',
      'local/no-snf-backend': 'off',
      'local/no-module-global-state': 'off',
    },
  },
)
