/**
 * local/no-snf-backend
 *
 * SPEC prohibition #5 (54-SPEC.md): "O SDK MUST NOT chamar `app.sweepnflip.io/api/*`,
 * embutir chaves de terceiros (Alchemy/OpenSea/CoinGecko) nem ler `process.env` em
 * runtime — o parceiro traz o provider." Target: packages/*\/src. This is the lint-time
 * half of R19; scripts/grep-gate.mjs (Task 3) is the CI-time half that also covers `dist`.
 */

const BANNED_STRING_PATTERNS = [
  { re: /sweepnflip\.io/, id: 'endpoint' },
  { re: /NEXT_PUBLIC_/, id: 'envPrefix' },
  { re: /OPENSEA_API_KEY/, id: 'thirdPartyKey' },
  { re: /ALCHEMY/, id: 'thirdPartyKey' },
  { re: /COINGECKO/, id: 'thirdPartyKey' },
]

// Relative imports, viem/wagmi/react-query/react(-dom) and our own scoped packages are
// the only allowed non-relative sources — anything else (axios, a fetch wrapper, an SDK
// the partner didn't ask for) is disallowed per R19's "zero import outside these".
const ALLOWED_IMPORT_SOURCES = [
  /^\.\.?\//,
  /^viem(\/.*)?$/,
  /^wagmi(\/.*)?$/,
  /^@tanstack\/react-query$/,
  /^react$/,
  /^react-dom$/,
  /^@sweepnflip\/.*$/,
]

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Ban SnF backend calls, third-party keys, process.env reads and disallowed imports (SPEC prohibition #5, R19).',
    },
    messages: {
      endpoint:
        'SDK MUST NOT call an SnF backend endpoint (SPEC prohibition #5, R19): found "sweepnflip.io" in a literal.',
      envPrefix:
        'SDK MUST NOT reference a NEXT_PUBLIC_ env var (SPEC prohibition #5, R19) — the SDK is not a Next.js app; the partner brings the config.',
      thirdPartyKey:
        'SDK MUST NOT embed a third-party API key literal (Alchemy/OpenSea/CoinGecko) (SPEC prohibition #5, R19) — the partner brings the provider.',
      processEnv:
        'SDK MUST NOT read process.env at runtime (SPEC prohibition #5, R19) — the partner brings the provider/config.',
      disallowedImport:
        'SDK MUST NOT import "{{source}}" — only viem, wagmi, @tanstack/react-query, react/react-dom, relative modules and @sweepnflip/* are allowed in packages/*/src (SPEC prohibition #5, R19).',
    },
    schema: [],
  },
  create(context) {
    function checkStringValue(node, value) {
      for (const { re, id } of BANNED_STRING_PATTERNS) {
        if (re.test(value)) context.report({ node, messageId: id })
      }
    }
    return {
      Literal(node) {
        if (typeof node.value === 'string') checkStringValue(node, node.value)
      },
      TemplateLiteral(node) {
        checkStringValue(node, node.quasis.map((q) => q.value.raw).join(''))
      },
      MemberExpression(node) {
        if (
          node.object.type === 'Identifier' &&
          node.object.name === 'process' &&
          node.property.type === 'Identifier' &&
          node.property.name === 'env'
        ) {
          context.report({ node, messageId: 'processEnv' })
        }
      },
      ImportDeclaration(node) {
        const source = String(node.source.value)
        const allowed = ALLOWED_IMPORT_SOURCES.some((re) => re.test(source))
        if (!allowed) {
          context.report({ node, messageId: 'disallowedImport', data: { source } })
        }
      },
    }
  },
}
