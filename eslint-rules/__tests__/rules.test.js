import { RuleTester } from 'eslint'
import tseslint from 'typescript-eslint'
import { describe, it } from 'vitest'

import noModuleGlobalState from '../no-module-global-state.js'
import noSigningImports from '../no-signing-imports.js'
import noSnfBackend from '../no-snf-backend.js'

// RuleTester needs `it`/`describe` wired to vitest's globals (it has no built-in
// test-runner integration — this is ESLint's documented pattern for non-Mocha/Jest
// runners: https://eslint.org/docs/latest/integrate/nodejs-api#ruletester).
RuleTester.describe = describe
RuleTester.it = it

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    ecmaVersion: 2022,
    sourceType: 'module',
  },
})

ruleTester.run('no-signing-imports', noSigningImports, {
  valid: [
    { code: "import type { PublicClient } from 'viem'" },
    { code: 'const config = { chainId: 8453 }' },
  ],
  invalid: [
    {
      code: "import { privateKeyToAccount } from 'viem/accounts'",
      errors: [{ messageId: 'accountsModule' }],
    },
    {
      code: "import type { WalletClient } from 'viem'",
      errors: [{ messageId: 'signing' }],
    },
    {
      code: 'const x = { privateKey: userInput }',
      errors: [{ messageId: 'secretProperty' }],
    },
  ],
})

ruleTester.run('no-snf-backend', noSnfBackend, {
  valid: [
    { code: "import { getAddress } from 'viem'" },
    { code: "import { foo } from './bar'" },
  ],
  invalid: [
    {
      code: "fetch('https://app.sweepnflip.io/api/x')",
      errors: [{ messageId: 'endpoint' }],
    },
    {
      code: 'const key = process.env.ALCHEMY_KEY',
      errors: [{ messageId: 'processEnv' }],
    },
    {
      code: "import { x } from 'axios'",
      errors: [{ messageId: 'disallowedImport' }],
    },
  ],
})

ruleTester.run('no-module-global-state', noModuleGlobalState, {
  valid: [
    { code: 'const NET = 9800n' },
    { code: 'export const SNF_CHAINS = [1, 2, 3] as const' },
    { code: 'export function f() { const m = new Map(); return m }' },
  ],
  invalid: [
    {
      code: 'let cache = 0',
      errors: [{ messageId: 'mutableBinding' }],
    },
    {
      code: 'const cache = new Map()',
      errors: [{ messageId: 'mutableConstructor' }],
    },
  ],
})
