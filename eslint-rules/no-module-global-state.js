/**
 * local/no-module-global-state
 *
 * Explicit instance, no module-global state — no mutable `let`/`Map` at
 * module scope. Target: packages/sdk/src. Two clients on
 * the same page (Base + Arbitrum) must never share cache or breaker state — this rule
 * is the mechanical half; the behavioural half is this module's cross-talk test.
 *
 * Banned at Program (module top-level) scope:
 * - any `let`/`var` declaration
 * - any `const` initialised to `new Map/Set/WeakMap/WeakSet/AbortController(...)`
 * - any `const` initialised to a bare array literal (`[...]`)
 * Allowed: `const` initialised to a literal, `Object.freeze(...)`, an arrow function,
 * a function, or a `satisfies`/`as const` expression — the legitimate registry/ABI
 * shapes plans 03 and 04 need. Function-scoped declarations are always fine.
 */

const BANNED_CONSTRUCTORS = new Set(['Map', 'Set', 'WeakMap', 'WeakSet', 'AbortController'])

function isProgramScope(node) {
  const parent = node.parent
  if (!parent) return false
  if (parent.type === 'Program') return true
  if (
    (parent.type === 'ExportNamedDeclaration' || parent.type === 'ExportDefaultDeclaration') &&
    parent.parent &&
    parent.parent.type === 'Program'
  ) {
    return true
  }
  return false
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'Ban module-scope mutable state in packages/sdk/src.',
    },
    messages: {
      mutableBinding:
        'SDK core MUST NOT declare module-scope mutable state: "{{kind}}" at the top level can leak across client instances. Move it inside createSnfClient().',
      mutableConstructor:
        'SDK core MUST NOT initialise a module-scope const with "new {{name}}()" — this is shared, mutable state across every client instance on the page. Move it inside createSnfClient().',
      mutableArray:
        'SDK core MUST NOT initialise a module-scope const with a bare array literal — arrays are mutable. Use "as const" for a frozen registry shape, or move it inside createSnfClient().',
    },
    schema: [],
  },
  create(context) {
    return {
      VariableDeclaration(node) {
        if (!isProgramScope(node)) return

        if (node.kind === 'let' || node.kind === 'var') {
          context.report({ node, messageId: 'mutableBinding', data: { kind: node.kind } })
          return
        }

        for (const decl of node.declarations) {
          const init = decl.init
          if (!init) continue
          if (
            init.type === 'NewExpression' &&
            init.callee.type === 'Identifier' &&
            BANNED_CONSTRUCTORS.has(init.callee.name)
          ) {
            context.report({ node: decl, messageId: 'mutableConstructor', data: { name: init.callee.name } })
          } else if (init.type === 'ArrayExpression') {
            context.report({ node: decl, messageId: 'mutableArray' })
          }
        }
      },
    }
  },
}
