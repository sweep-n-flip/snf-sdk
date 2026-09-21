import noModuleGlobalState from './no-module-global-state.js'
import noSigningImports from './no-signing-imports.js'
import noSnfBackend from './no-snf-backend.js'

// Repo-local virtual ESLint plugin, registered as `local` in eslint.config.js.
// Exposes the three rules that make SPEC prohibitions #1, #5 and R3 machine-checkable.
export default {
  rules: {
    'no-signing-imports': noSigningImports,
    'no-snf-backend': noSnfBackend,
    'no-module-global-state': noModuleGlobalState,
  },
}
