import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { getChain, isSupportedChain, SNF_CHAIN_IDS, SNF_CHAINS } from '../../src/chains/registry'

/**
 * Registry-vs-`snf-client` diff (R2; 54-SPEC.md). Reads the production config files
 * `snf-client` actually ships **from disk**, at test time — never `import`s them (that
 * would trip `local/no-snf-backend` and pull an unrelated app's dependency graph into
 * this package). If a consumer clones `snf-sdk` standalone (no sibling `snf-client`
 * checkout), every case here `it.skip`s with a loud `console.warn` instead of failing.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const SNF_CLIENT_CONFIG = resolve(HERE, '../../../../../snf-client/src/config')

const CHAINS_PATH = resolve(SNF_CLIENT_CONFIG, 'chains.ts')
const CONTRACTS_PATH = resolve(SNF_CLIENT_CONFIG, 'contracts.ts')
const SUBGRAPHS_PATH = resolve(SNF_CLIENT_CONFIG, 'subgraphs.ts')

const SNF_CLIENT_AVAILABLE = existsSync(CHAINS_PATH) && existsSync(CONTRACTS_PATH) && existsSync(SUBGRAPHS_PATH)

if (!SNF_CLIENT_AVAILABLE) {
  // eslint-disable-next-line no-console
  console.warn(
    'coverage.test.ts: sibling snf-client checkout not found at ' +
      `${SNF_CLIENT_CONFIG} — skipping the registry-vs-production diff. ` +
      'This is expected only when snf-sdk is cloned standalone.',
  )
}

/** Well-known EIP-155 ids for the five chains `chains.ts` imports from `wagmi/chains`
 * instead of declaring locally via `defineChain` (so they carry no in-file `id: N`
 * to parse). These are public, stable chain ids — not SnF-specific data. */
const WAGMI_IMPORTED_IDS: Record<string, number> = {
  mainnet: 1,
  base: 8453,
  arbitrum: 42161,
  polygon: 137,
  avalanche: 43114,
}

/** Maps every local chain-object variable name in `chains.ts`/`contracts.ts` to its
 * numeric chainId, by reading each `export const <name> = defineChain({ id: N, ...` block
 * plus the well-known wagmi ids above. */
function parseIdByLocalName(chainsSource: string): Record<string, number> {
  const ids: Record<string, number> = { ...WAGMI_IMPORTED_IDS }
  const re = /export const (\w+) = defineChain\(\{\s*\n\s*id:\s*(\d+),/g
  let m: RegExpExecArray | null
  while ((m = re.exec(chainsSource))) {
    ids[m[1]!] = Number(m[2])
  }
  return ids
}

/** Parses the ordered local-name list out of `export const supportedChains = [...]`. */
function parseSupportedChainsOrder(chainsSource: string): string[] {
  const m = /export const supportedChains = \[([^\]]+)\]/.exec(chainsSource)
  if (!m) throw new Error('supportedChains literal not found in chains.ts')
  return m[1]!.split(',').map((s) => s.trim()).filter(Boolean)
}

/** Extracts every top-level `const NAME: Address = '0x...'` binding in contracts.ts. */
function parseAddressConstants(contractsSource: string): Record<string, string> {
  const consts: Record<string, string> = {}
  const re = /const (\w+): Address = '(0x[0-9a-fA-F]{40})'/g
  let m: RegExpExecArray | null
  while ((m = re.exec(contractsSource))) {
    consts[m[1]!] = m[2]!
  }
  return consts
}

/** Extracts the `[localName.id]: { latest: { ... }, ... },` block for one chain — from
 * the opening brace through the first 2-space-indented `},` that closes it. */
function extractChainBlock(contractsSource: string, localName: string): string {
  const re = new RegExp(`\\[${localName}\\.id\\]:\\s*\\{([\\s\\S]*?)\\n  \\},`)
  const m = re.exec(contractsSource)
  if (!m) throw new Error(`block for [${localName}.id] not found in contracts.ts`)
  return m[1]!
}

function resolveFieldAddress(
  block: string,
  field: 'factory' | 'router02' | 'weth' | 'multicall3',
  addressConsts: Record<string, string>,
): string {
  const re = new RegExp(`${field}:\\s*([^,\\n]+),`)
  const m = re.exec(block)
  if (!m) throw new Error(`field ${field} not found in block`)
  const raw = m[1]!.trim()
  const literal = /^'(0x[0-9a-fA-F]{40})'$/.exec(raw)
  if (literal) return literal[1]!
  const resolved = addressConsts[raw]
  if (!resolved) throw new Error(`could not resolve identifier "${raw}" for field ${field}`)
  return resolved
}

/** Every literal Goldsky subgraph URL appearing in subgraphs.ts. */
function parseSubgraphUrls(subgraphsSource: string): string[] {
  const re = /'(https:\/\/api\.goldsky\.com\/[^']+)'/g
  const urls: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(subgraphsSource))) {
    urls.push(m[1]!)
  }
  return urls
}

const maybeDescribe = SNF_CLIENT_AVAILABLE ? describe : describe.skip

maybeDescribe('registry vs snf-client (production config diff)', () => {
  const chainsSource = SNF_CLIENT_AVAILABLE ? readFileSync(CHAINS_PATH, 'utf8') : ''
  const contractsSource = SNF_CLIENT_AVAILABLE ? readFileSync(CONTRACTS_PATH, 'utf8') : ''
  const subgraphsSource = SNF_CLIENT_AVAILABLE ? readFileSync(SUBGRAPHS_PATH, 'utf8') : ''

  const idByLocalName = SNF_CLIENT_AVAILABLE ? parseIdByLocalName(chainsSource) : {}
  const supportedOrder = SNF_CLIENT_AVAILABLE ? parseSupportedChainsOrder(chainsSource) : []
  const expectedIdOrder = supportedOrder.map((name) => {
    const id = idByLocalName[name]
    if (id === undefined) throw new Error(`no id resolved for local chain name "${name}"`)
    return id
  })

  it('SNF_CHAIN_IDS has the same members in the same order as supportedChains', () => {
    expect(SNF_CHAIN_IDS).toEqual(expectedIdOrder)
  })

  it('SNF_CHAINS has exactly 14 entries — a deleted chain fails this hard number', () => {
    expect(SNF_CHAINS).toHaveLength(14)
    expect(expectedIdOrder).toHaveLength(14)
  })

  it('every chain\'s factory, router02, quoteToken and multicall3 match contracts.ts\'s latest branch', () => {
    const addressConsts = parseAddressConstants(contractsSource)
    const mismatches: string[] = []

    for (const [localName, id] of Object.entries(idByLocalName)) {
      const chain = SNF_CHAINS.find((c) => c.chainId === id)
      if (!chain) continue // not every wagmi-imported id is necessarily an SnF chain
      const block = extractChainBlock(contractsSource, localName)

      const expectedFactory = resolveFieldAddress(block, 'factory', addressConsts)
      const expectedRouter02 = resolveFieldAddress(block, 'router02', addressConsts)
      const expectedQuoteToken = resolveFieldAddress(block, 'weth', addressConsts)
      const expectedMulticall3 = resolveFieldAddress(block, 'multicall3', addressConsts)

      if (chain.factory.toLowerCase() !== expectedFactory.toLowerCase()) {
        mismatches.push(`${chain.name} (${id}): factory ${chain.factory} !== ${expectedFactory}`)
      }
      if (chain.router02.toLowerCase() !== expectedRouter02.toLowerCase()) {
        mismatches.push(`${chain.name} (${id}): router02 ${chain.router02} !== ${expectedRouter02}`)
      }
      if (chain.quoteToken.toLowerCase() !== expectedQuoteToken.toLowerCase()) {
        mismatches.push(`${chain.name} (${id}): quoteToken ${chain.quoteToken} !== ${expectedQuoteToken}`)
      }
      if (chain.multicall3.toLowerCase() !== expectedMulticall3.toLowerCase()) {
        mismatches.push(`${chain.name} (${id}): multicall3 ${chain.multicall3} !== ${expectedMulticall3}`)
      }
    }

    expect(mismatches).toEqual([])
  })

  it('every registry subgraphUrl appears verbatim in subgraphs.ts, and both sides count 14', () => {
    const clientUrls = parseSubgraphUrls(subgraphsSource)
    expect(clientUrls).toHaveLength(14)
    expect(SNF_CHAINS).toHaveLength(14)

    const missing = SNF_CHAINS.filter((c) => !clientUrls.includes(c.subgraphUrl)).map((c) => c.name)
    expect(missing).toEqual([])
  })

  it('chainIds are unique, and no two chains share the same (factory, router02, subgraphUrl) triple', () => {
    expect(new Set(SNF_CHAIN_IDS).size).toBe(14)

    const triples = SNF_CHAINS.map((c) => `${c.factory}|${c.router02}|${c.subgraphUrl}`)
    expect(new Set(triples).size).toBe(SNF_CHAINS.length)
  })

  it('getChain(999999) throws INVALID_PARAMS; getChain/isSupportedChain have arity 1', () => {
    expect(() => getChain(999_999)).toThrow()
    try {
      getChain(999_999)
    } catch (err) {
      expect((err as { code?: string }).code).toBe('INVALID_PARAMS')
    }
    expect(getChain.length).toBe(1)
    expect(isSupportedChain.length).toBe(1)
  })

  it('no registry value contains "legacy" (case-insensitive)', () => {
    const offenders = SNF_CHAINS.filter((c) =>
      Object.values(c).some((v) => typeof v === 'string' && /legacy/i.test(v)),
    )
    expect(offenders).toEqual([])
  })

  it('Arc (5042) is the only chain with quoteDecimals 6 / no native wrapper / native-erc20 variant', () => {
    for (const chain of SNF_CHAINS) {
      if (chain.chainId === 5042) {
        expect(chain.quoteDecimals).toBe(6)
        expect(chain.hasNativeWrapper).toBe(false)
        expect(chain.routerVariant).toBe('native-erc20')
      } else {
        expect(chain.quoteDecimals, `chain ${chain.chainId}`).toBe(18)
        expect(chain.hasNativeWrapper, `chain ${chain.chainId}`).toBe(true)
        expect(chain.routerVariant, `chain ${chain.chainId}`).toBe('standard')
      }
    }
  })
})
