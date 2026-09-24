/**
 * local/no-effect-dispatch
 *
 * The documented prohibition #4 (amended 2026-09-23 list): "calls `next()` from inside
 * an effect, a timer or a watcher." Requirement 8 / INV-17: the action button maps one
 * user click to one `next()` call; the kit never calls `next()` from an effect, a
 * timer or a watcher — every on-chain step is its own labelled click. Target:
 * packages/widgets/src only (see eslint.config.js).
 *
 * Visitor: find every `useEffect(...)` (or `React.useEffect(...)`) call, take its first
 * argument, and if it is a function, recursively walk its ENTIRE lexical body — every
 * descendant node, including nested function/arrow bodies — for a call to `next()` or
 * `*.next()`. A `setTimeout` callback or a `.then()` callback declared INSIDE the
 * effect body is still inside the effect's lexical scope for this rule's purpose,
 * which is why the walk does not stop at the first nested function boundary.
 *
 * The walk is a small manual traversal over `Object.keys(node)` (the same low-tech
 * approach no-module-global-state.js models for a smaller case) rather than a
 * dependency on eslint-visitor-keys — no new dependency is added for this rule.
 */

function isNextIdentifierOrMember(node) {
  if (node.type === 'Identifier' && node.name === 'next') return true
  return (
    node.type === 'MemberExpression' &&
    !node.computed &&
    node.property.type === 'Identifier' &&
    node.property.name === 'next'
  )
}

function isNextCall(node) {
  return node.type === 'CallExpression' && isNextIdentifierOrMember(node.callee)
}

function isUseEffectCallee(callee) {
  if (callee.type === 'Identifier' && callee.name === 'useEffect') return true
  return (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.property.type === 'Identifier' &&
    callee.property.name === 'useEffect'
  )
}

// Manual recursive AST walk, skipping the `parent` back-reference ESLint attaches
// during its own traversal (avoids a cycle) and any non-node value.
function walk(node, visit) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit)
    return
  }
  if (typeof node.type === 'string') {
    visit(node)
  }
  for (const key of Object.keys(node)) {
    if (key === 'parent') continue
    const value = node[key]
    if (value && typeof value === 'object') {
      walk(value, visit)
    }
  }
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Ban a next()/.next() dispatch anywhere in the lexical body of a useEffect callback in packages/widgets/src (INV-17).',
    },
    messages: {
      nextInEffect:
        'Widgets MUST NOT dispatch from an effect, a timer or a watcher (INV-17): a next() call was found inside a useEffect body. Every on-chain step must map to one user click, not an automatic advance.',
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        if (!isUseEffectCallee(node.callee)) return

        const [effectArg] = node.arguments
        if (!effectArg) return
        if (
          effectArg.type !== 'FunctionExpression' &&
          effectArg.type !== 'ArrowFunctionExpression'
        ) {
          return
        }

        walk(effectArg.body, (inner) => {
          if (isNextCall(inner)) {
            context.report({ node: inner, messageId: 'nextInEffect' })
          }
        })
      },
    }
  },
}
