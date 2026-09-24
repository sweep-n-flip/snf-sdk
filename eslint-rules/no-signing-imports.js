/**
 * local/no-signing-imports
 *
 * This SDK never signs, relays or custodies: no API accepts a private key, a
 * `WalletClient`, or `signTransaction`; the builders return calldata only. The
 * core NEVER receives a WalletClient or sends anything — this is the lint half
 * of that boundary. Target: packages/sdk/src only (registered off for
 * packages/sdk-react/src, where the adapter is the one legitimate dispatch site
 * — see eslint.config.js).
 */

const BANNED_IMPORT_NAMES = new Set([
  'WalletClient',
  'Account',
  'PrivateKeyAccount',
  'privateKeyToAccount',
  'mnemonicToAccount',
  'hdKeyToAccount',
  'signTransaction',
  'signMessage',
  'signTypedData',
  'sendTransaction',
  'sendRawTransaction',
  'createWalletClient',
])

const BANNED_PROPERTY_NAMES = new Set(['privateKey', 'mnemonic', 'secretKey'])

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Ban signing/custody surfaces in packages/sdk/src.',
    },
    messages: {
      signing:
        'SDK core MUST NOT sign, relay or custody: "{{name}}" is a signing surface. Builders return calldata only.',
      accountsModule:
        'SDK core MUST NOT import from "viem/accounts" — every export of this module is a signing/custody primitive.',
      secretProperty:
        'SDK core MUST NOT hold a "{{name}}" property — the SDK never accepts or stores private key material.',
    },
    schema: [],
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        if (node.source.value === 'viem/accounts') {
          context.report({ node, messageId: 'accountsModule' })
          return
        }
        for (const spec of node.specifiers) {
          if (spec.type !== 'ImportSpecifier') continue
          const name =
            spec.imported.type === 'Identifier' ? spec.imported.name : String(spec.imported.value)
          if (BANNED_IMPORT_NAMES.has(name)) {
            context.report({ node: spec, messageId: 'signing', data: { name } })
          }
        }
      },
      Property(node) {
        const key = node.key
        const name =
          key.type === 'Identifier' ? key.name : key.type === 'Literal' ? String(key.value) : undefined
        if (name && BANNED_PROPERTY_NAMES.has(name)) {
          context.report({ node: key, messageId: 'secretProperty', data: { name } })
        }
      },
      TSPropertySignature(node) {
        const key = node.key
        const name = key.type === 'Identifier' ? key.name : undefined
        if (name && BANNED_PROPERTY_NAMES.has(name)) {
          context.report({ node: key, messageId: 'secretProperty', data: { name } })
        }
      },
    }
  },
}
