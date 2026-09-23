/**
 * local/no-amount-arithmetic
 *
 * 56-SPEC.md R3 prohibition #2 (amended 2026-09-23 list): "performs arithmetic on a
 * money value." Every number the widgets kit shows comes from the SDK's `Amount` as
 * given — `formatted`/`symbol` for display, never a recomputation of `value`. Target:
 * packages/widgets/src only (see eslint.config.js).
 *
 * This is a syntactic heuristic keyed on the SDK's own `Amount.value` field name, not a
 * type-checked rule — it cannot see through an alias that renames the field (e.g.
 * `const { value: v } = quote.totalCost; v + 1n` slips past it). That tradeoff is
 * accepted because `Amount` is a stable, documented shape (54-SPEC.md), so the
 * `.value` member-access pattern is the overwhelmingly common way a contributor would
 * reach for the raw bigint. Bigint literals are banned outright for the same reason:
 * there is no legitimate reason for widgets source to construct or combine a raw bigint
 * at all.
 */

function isBigIntLiteral(node) {
  return (
    node.type === 'Literal' &&
    (typeof node.value === 'bigint' || typeof node.bigint === 'string')
  )
}

function isAmountOperand(node) {
  if (
    node.type === 'MemberExpression' &&
    !node.computed &&
    node.property.type === 'Identifier' &&
    node.property.name === 'value'
  ) {
    return true
  }
  return isBigIntLiteral(node)
}

const BINARY_OPERATORS = new Set(['+', '-', '*', '/', '%', '**'])
const ASSIGNMENT_OPERATORS = new Set(['+=', '-=', '*=', '/=', '%=', '**='])

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Ban arithmetic on an Amount.value member access or a bigint literal in packages/widgets/src (56-SPEC.md R3).',
    },
    messages: {
      amountArithmetic:
        'Widgets MUST NOT perform arithmetic on a money value (56-SPEC.md R3): render Amount.formatted/symbol as given, never recompute .value. Every number shown must come from the SDK.',
    },
    schema: [],
  },
  create(context) {
    return {
      BinaryExpression(node) {
        if (!BINARY_OPERATORS.has(node.operator)) return
        if (isAmountOperand(node.left) || isAmountOperand(node.right)) {
          context.report({ node, messageId: 'amountArithmetic' })
        }
      },
      AssignmentExpression(node) {
        if (!ASSIGNMENT_OPERATORS.has(node.operator)) return
        if (isAmountOperand(node.left)) {
          context.report({ node, messageId: 'amountArithmetic' })
        }
      },
      UnaryExpression(node) {
        if (node.operator !== '-' && node.operator !== '+') return
        if (isAmountOperand(node.argument)) {
          context.report({ node, messageId: 'amountArithmetic' })
        }
      },
    }
  },
}
