import noAmountArithmetic from './no-amount-arithmetic.js'
import noContractCalls from './no-contract-calls.js'
import noEffectDispatch from './no-effect-dispatch.js'
import noModuleGlobalState from './no-module-global-state.js'
import noNumericFormatting from './no-numeric-formatting.js'
import noSigningImports from './no-signing-imports.js'
import noSnfBackend from './no-snf-backend.js'

// Repo-local virtual ESLint plugin, registered as `local` in eslint.config.js.
// Exposes the three rules that make the SDK's signing/custody and
// backend-access prohibitions machine-checkable, plus the four rules that
// make widgets' own five-guard prohibition list machine-checkable.
export default {
  rules: {
    'no-signing-imports': noSigningImports,
    'no-snf-backend': noSnfBackend,
    'no-module-global-state': noModuleGlobalState,
    'no-contract-calls': noContractCalls,
    'no-amount-arithmetic': noAmountArithmetic,
    'no-numeric-formatting': noNumericFormatting,
    'no-effect-dispatch': noEffectDispatch,
  },
}
