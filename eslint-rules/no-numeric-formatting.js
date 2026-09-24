/**
 * local/no-numeric-formatting
 *
 * The documented prohibition #3 (amended 2026-09-23 list): "calls a numeric formatting
 * function." Requirement 9: "the kit displays `formatted` and `symbol` as given; it
 * never calls `toFixed`, `toLocaleString` or any arithmetic on `value`." Target:
 * packages/widgets/src only (see eslint.config.js). The arithmetic half of this
 * prohibition is
 * mechanised by local/no-amount-arithmetic; this rule is the formatting half.
 *
 * `bigint.toString()` is deliberately NOT flagged anywhere in this rule. this rule's ban is
 * `toFixed`/`toLocaleString`/arithmetic-on-`.value` — reformatting a *money* value — not
 * the ability to print a block number or a raw reserve count as digits.
 * `SwapPanel.tsx`'s own `asOfBlock.toString()` is the precedent this rule preserves:
 * `toString()` on a bigint that is not a money amount is plain text rendering, not
 * reformatting.
 *
 * `Number`/`parseFloat`/`parseInt` are banned as bare global calls only (an Identifier
 * callee) — a MemberExpression access like `Math.floor(...)` is a distinct, unbanned
 * concern and must not be flagged by this rule.
 */

const BANNED_METHOD_NAMES = new Set(['toFixed', 'toLocaleString'])
const BANNED_GLOBAL_NAMES = new Set(['Number', 'parseFloat', 'parseInt'])

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Ban toFixed/toLocaleString/Number/parseFloat/parseInt/Intl.NumberFormat calls and formatAmount/toAmount imports in packages/widgets/src.',
    },
    messages: {
      formattingCall:
        'Widgets MUST NOT reformat a numeric value: "{{name}}" is a numeric formatting call. Display Amount.formatted/symbol as given.',
      formattingImport:
        'Widgets MUST NOT import "{{name}}" from @sweepnflip/sdk — the kit only renders the Amount the SDK already formatted; it never reformats a value itself.',
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee

        if (
          callee.type === 'MemberExpression' &&
          !callee.computed &&
          callee.property.type === 'Identifier' &&
          BANNED_METHOD_NAMES.has(callee.property.name)
        ) {
          context.report({
            node,
            messageId: 'formattingCall',
            data: { name: callee.property.name },
          })
          return
        }

        if (callee.type === 'Identifier' && BANNED_GLOBAL_NAMES.has(callee.name)) {
          context.report({ node, messageId: 'formattingCall', data: { name: callee.name } })
        }
      },
      NewExpression(node) {
        const callee = node.callee
        if (
          callee.type === 'MemberExpression' &&
          !callee.computed &&
          callee.object.type === 'Identifier' &&
          callee.object.name === 'Intl' &&
          callee.property.type === 'Identifier' &&
          callee.property.name === 'NumberFormat'
        ) {
          context.report({
            node,
            messageId: 'formattingCall',
            data: { name: 'Intl.NumberFormat' },
          })
        }
      },
      ImportDeclaration(node) {
        if (node.source.value !== '@sweepnflip/sdk') return
        for (const spec of node.specifiers) {
          if (spec.type !== 'ImportSpecifier') continue
          const name =
            spec.imported.type === 'Identifier' ? spec.imported.name : String(spec.imported.value)
          if (name === 'formatAmount' || name === 'toAmount') {
            context.report({ node: spec, messageId: 'formattingImport', data: { name } })
          }
        }
      },
    }
  },
}
