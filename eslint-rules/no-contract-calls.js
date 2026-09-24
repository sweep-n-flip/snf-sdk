/**
 * local/no-contract-calls
 *
 * Widgets never import a contract ABI or call a Router method directly. The
 * widgets kit renders the SDK; it never talks to a contract directly. Target:
 * packages/widgets/src only (see eslint.config.js).
 *
 * Three surfaces are banned:
 * - importing the `abis` namespace from `@sweepnflip/sdk` (packages/sdk/src/index.ts
 * exports it as `export * as abis from './abis'` — a named specifier, not a deep
 * path, so the ban is on the specifier name)
 * - importing any wagmi contract read/write hook
 * - importing a contract-calling action from `viem` or `wagmi/actions`
 */

const BANNED_WAGMI_HOOKS = new Set([
  'useReadContract',
  'useReadContracts',
  'useWriteContract',
  'useSimulateContract',
  'useContractRead',
  'useContractWrite',
  'useContractReads',
])

const BANNED_CONTRACT_ACTIONS = new Set([
  'readContract',
  'writeContract',
  'simulateContract',
  'getContract',
  'multicall',
])

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Ban ABI-namespace imports, wagmi contract hooks and viem/wagmi-actions contract calls in packages/widgets/src.',
    },
    messages: {
      abiImport:
        'Widgets MUST NOT import a contract ABI: "{{name}}" is a direct contract surface. Read quotes and state from the SDK/sdk-react hooks only.',
      contractHook:
        'Widgets MUST NOT call a contract directly: "{{name}}" is a wagmi contract read/write hook, not a Router-method call routed through the SDK.',
      contractAction:
        'Widgets MUST NOT call a contract directly: "{{name}}" is a viem/wagmi-actions contract read/write, not a Router-method call routed through the SDK.',
    },
    schema: [],
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        const source = String(node.source.value)

        if (source === '@sweepnflip/sdk') {
          for (const spec of node.specifiers) {
            if (spec.type !== 'ImportSpecifier') continue
            const name =
              spec.imported.type === 'Identifier'
                ? spec.imported.name
                : String(spec.imported.value)
            if (name === 'abis') {
              context.report({ node: spec, messageId: 'abiImport', data: { name } })
            }
          }
          return
        }

        if (source === 'wagmi') {
          for (const spec of node.specifiers) {
            if (spec.type !== 'ImportSpecifier') continue
            const name =
              spec.imported.type === 'Identifier'
                ? spec.imported.name
                : String(spec.imported.value)
            if (BANNED_WAGMI_HOOKS.has(name)) {
              context.report({ node: spec, messageId: 'contractHook', data: { name } })
            }
          }
          return
        }

        if (source === 'viem' || source === 'wagmi/actions') {
          for (const spec of node.specifiers) {
            if (spec.type !== 'ImportSpecifier') continue
            const name =
              spec.imported.type === 'Identifier'
                ? spec.imported.name
                : String(spec.imported.value)
            if (BANNED_CONTRACT_ACTIONS.has(name)) {
              context.report({ node: spec, messageId: 'contractAction', data: { name } })
            }
          }
        }
      },
    }
  },
}
