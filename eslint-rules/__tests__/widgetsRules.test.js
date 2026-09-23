import { RuleTester } from 'eslint'
import tseslint from 'typescript-eslint'
import { describe, it } from 'vitest'

import noAmountArithmetic from '../no-amount-arithmetic.js'
import noContractCalls from '../no-contract-calls.js'
import noEffectDispatch from '../no-effect-dispatch.js'
import noNumericFormatting from '../no-numeric-formatting.js'

// Sibling to rules.test.js (the core package's own three-rule suite) — this file
// covers only the four widgets-specific rules from 56-SPEC.md R3/R8/R9, D-08. Same
// RuleTester/vitest wiring as rules.test.js
// (https://eslint.org/docs/latest/integrate/nodejs-api#ruletester).
RuleTester.describe = describe
RuleTester.it = it

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    ecmaVersion: 2022,
    sourceType: 'module',
  },
})

ruleTester.run('no-contract-calls', noContractCalls, {
  valid: [
    { code: "import { createSnfClient } from '@sweepnflip/sdk'" },
    { code: "import { useSnfCheckout } from '@sweepnflip/sdk-react'" },
  ],
  invalid: [
    {
      code: "import { abis } from '@sweepnflip/sdk'",
      errors: [{ messageId: 'abiImport' }],
    },
    {
      code: "import { useReadContract } from 'wagmi'",
      errors: [{ messageId: 'contractHook' }],
    },
    {
      code: "import { readContract } from 'viem'",
      errors: [{ messageId: 'contractAction' }],
    },
  ],
})

ruleTester.run('no-amount-arithmetic', noAmountArithmetic, {
  valid: [
    { code: 'const x = props.value' },
    { code: 'const y = 1 + 2' },
  ],
  invalid: [
    {
      code: 'const total = quote.totalCost.value + fee.value',
      errors: [{ messageId: 'amountArithmetic' }],
    },
    {
      code: 'const x = 3n * 2n',
      errors: [{ messageId: 'amountArithmetic' }],
    },
  ],
})

ruleTester.run('no-numeric-formatting', noNumericFormatting, {
  valid: [
    { code: 'const s = value.toString()' },
    { code: 'const s = label.trim()' },
  ],
  invalid: [
    {
      code: 'const s = n.toFixed(2)',
      errors: [{ messageId: 'formattingCall' }],
    },
    {
      code: 'const n = Number(x)',
      errors: [{ messageId: 'formattingCall' }],
    },
    {
      code: "import { formatAmount } from '@sweepnflip/sdk'",
      errors: [{ messageId: 'formattingImport' }],
    },
  ],
})

ruleTester.run('no-effect-dispatch', noEffectDispatch, {
  valid: [
    { code: "useEffect(() => { console.log('mounted') }, [])" },
    { code: 'function onClick() { checkout.next() }' },
  ],
  invalid: [
    {
      code: 'useEffect(() => { checkout.next() }, [plan])',
      errors: [{ messageId: 'nextInEffect' }],
    },
    {
      code: 'useEffect(() => { setTimeout(() => next(), 0) }, [])',
      errors: [{ messageId: 'nextInEffect' }],
    },
  ],
})
