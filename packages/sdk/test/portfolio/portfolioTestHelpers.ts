import type { PublicClient } from 'viem'
import { vi } from 'vitest'

import { getChain } from '../../src/chains/registry'
import { resolveProviders } from '../../src/providers/defaults'
import type { SnfClientConfig, SnfClientContext } from '../../src/types/client.types'
import type { DataProviders } from '../../src/types/providers.types'
import type { SubgraphPair, SubgraphToken } from '../../src/transport/subgraph.types'

/**
 * `buildPortfolioEnv(cfg)` — the shared mocked chain + subgraph every portfolio test
 * uses (this plan, and later plans per this plan's own `output` note). Not itself a
 * `*.test.ts` file (vitest's glob excludes it), so it adds no test count.
 *
 * Like `test/liquidity/liquidityTestHelpers.ts`'s `buildLiquidityEnv`, every multicall
 * call is dispatched INDIVIDUALLY, keyed by address + functionName (+ first arg where
 * needed, e.g. `balanceOf(pair)` vs `balanceOf(owner)`) — never by matching a whole
 * batch's shape. `providers` is resolved through the real `resolveProviders`, exactly
 * as `createSnfClient` itself does, so an unconfigured test gets real `NO_PROVIDER`
 * defaults, not a bare `{}`.
 */

export type ReadResult = { readonly status: 'success' | 'failure'; readonly result?: unknown }

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as `0x${string}`

/** A deterministic, valid `0x` + 40-hex address from a small integer seed — used by
 * fixtures (e.g. a pagination test needing hundreds of distinct pair addresses) that
 * don't care about any particular address value. */
export function testAddress(seed: number): `0x${string}` {
  return `0x${seed.toString(16).padStart(40, '0')}` as `0x${string}`
}

export interface RecordedCall {
  readonly address: string
  readonly functionName: string
  readonly args: readonly unknown[]
  readonly blockNumber: bigint | undefined
}

export interface PortfolioBaseTokenConfig {
  readonly address: `0x${string}`
  readonly decimals: number
  readonly symbol: string
}

export interface PortfolioPairSubgraphOverrides {
  readonly isNFTPool?: boolean
  readonly discrete0?: boolean
  readonly discrete1?: boolean
  readonly collectionName?: string | null
  readonly collectionSymbol?: string | null
  /** Drops `collection` from the discrete token's subgraph row entirely. */
  readonly dropCollection?: boolean
}

export interface PortfolioPairConfig {
  readonly pair: `0x${string}`
  readonly wrapper: `0x${string}`
  readonly collection: `0x${string}`
  /** `null`/omitted — the chain's own `quoteToken` (the native pool). */
  readonly base?: PortfolioBaseTokenConfig | null
  readonly wrapperIsToken0?: boolean
  readonly reserves?: { readonly base: bigint; readonly wnft: bigint }
  /** Defaults to `reserves`. */
  readonly balances?: { readonly base: bigint; readonly wnft: bigint }
  readonly totalSupply?: bigint
  /** owner (any case) -> this pair's own LP balance. */
  readonly lp?: Readonly<Record<string, bigint>>
  /** `false` makes `Factory.getPair` answer a DIFFERENT address than `pair` — the
   * spoofed/stale-pair case `loadPairState` must reject. Default `true`. */
  readonly factoryListed?: boolean
  readonly subgraph?: PortfolioPairSubgraphOverrides
  /** `ERC20_ABI.name()/symbol()` on the collection address (label waterfall's second
   * pass). Omitted means that read fails. */
  readonly onChainName?: string
  readonly onChainSymbol?: string
  /** The pair's own `balanceOf(owner)` (the scan's first round) fails. */
  readonly failScan?: boolean
  /** `token0()` (inside `loadPairState`) fails — an unreadable/dead pair once the scan
   * already found a non-zero balance. */
  readonly failLoad?: boolean
}

export interface PortfolioEnvConfig {
  readonly chainId?: 8453 | 5042 | 56
  readonly blockNumber?: bigint
  readonly feeTo?: `0x${string}`
  readonly providers?: DataProviders
  readonly pairs?: readonly PortfolioPairConfig[]
  /** Raw extra subgraph rows (e.g. BNB's delegated SushiSwap pairs) appended verbatim
   * after the generated NFT-pool rows. */
  readonly extraRows?: readonly SubgraphPair[]
  readonly asOfBlock?: bigint
  readonly lagSeconds?: number
  readonly stale?: boolean
  /** wrapper (any case) -> owner (any case) -> wNFT balance. */
  readonly wnft?: Readonly<Record<string, Readonly<Record<string, bigint>>>>
  readonly wrapperDecimals?: number
  /** address (any case) -> `Factory.getCollection(address)` override. Defaults to the
   * matching pair's own `collection` when `address` is a configured wrapper. */
  readonly factoryCollection?: Readonly<Record<string, `0x${string}`>>
  /** collection (any case) -> owner (any case) -> `ERC721.balanceOf(owner)`. */
  readonly erc721?: Readonly<Record<string, Readonly<Record<string, bigint>>>>
  readonly failErc721?: boolean
  /** Wrapper addresses (any case) whose owner-balance read fails — the `wnftBalances`
   * NO_ROUTE skip path. */
  readonly failWnftBalanceOf?: readonly `0x${string}`[]
}

export interface PortfolioEnv {
  readonly ctx: SnfClientContext
  readonly multicall: ReturnType<typeof vi.fn>
  readonly getBlockNumber: ReturnType<typeof vi.fn>
  readonly pools: ReturnType<typeof vi.fn>
  calls(): readonly RecordedCall[]
  /** Largest number of `multicall` calls simultaneously in flight — each mocked call
   * awaits one macrotask before resolving, so this measures real concurrency. */
  maxInFlight(): number
}

function isAddr(addr: string, target: string | null | undefined): boolean {
  return target !== null && target !== undefined && addr.toLowerCase() === target.toLowerCase()
}
function argsOf(args: readonly unknown[] | undefined): readonly unknown[] {
  return args ?? []
}
/** Case-insensitive record lookup — test configs key by whatever casing the caller wrote. */
function lookupCI<V>(record: Readonly<Record<string, V>> | undefined, key: string): V | undefined {
  if (record === undefined) return undefined
  const lower = key.toLowerCase()
  for (const [k, v] of Object.entries(record)) {
    if (k.toLowerCase() === lower) return v
  }
  return undefined
}

function buildNftPoolRow(p: PortfolioPairConfig, chain: ReturnType<typeof getChain>): SubgraphPair {
  const wrapperIsToken0 = p.wrapperIsToken0 ?? true
  const baseAddress = p.base?.address ?? chain.quoteToken
  const baseDecimals = p.base?.decimals ?? chain.quoteDecimals
  const baseSymbol = p.base?.symbol ?? chain.nativeSymbol
  const sub = p.subgraph ?? {}
  const isNFTPool = sub.isNFTPool ?? true
  const discrete0 = sub.discrete0 ?? wrapperIsToken0
  const discrete1 = sub.discrete1 ?? !wrapperIsToken0
  const collectionName = sub.dropCollection ? null : (sub.collectionName ?? 'Collection')
  const collectionSymbol = sub.dropCollection ? null : (sub.collectionSymbol ?? 'NFT')

  const collectionRef = sub.dropCollection
    ? null
    : { id: p.collection, name: collectionName, symbol: collectionSymbol, wrapper: { id: p.wrapper } }
  const wrapperToken: SubgraphToken = { id: p.wrapper, symbol: 'WNFT', name: 'Wrapped NFT', decimals: 18, collection: collectionRef }
  const baseToken: SubgraphToken = { id: baseAddress, symbol: baseSymbol, name: baseSymbol, decimals: baseDecimals, collection: null }
  const reserves = p.reserves ?? { base: 0n, wnft: 0n }
  const [reserve0, reserve1] = wrapperIsToken0 ? [reserves.wnft, reserves.base] : [reserves.base, reserves.wnft]

  return {
    id: p.pair,
    discrete0,
    discrete1,
    isNFTPool,
    token0: wrapperIsToken0 ? wrapperToken : baseToken,
    token1: wrapperIsToken0 ? baseToken : wrapperToken,
    reserve0: reserve0.toString(),
    reserve1: reserve1.toString(),
    totalSupply: (p.totalSupply ?? 0n).toString(),
    reserveETH: '0',
    reserveUSD: '0',
    volumeToken0: '0',
    volumeToken1: '0',
    volumeUSD: '0',
    txCount: '0',
  }
}

export function buildPortfolioEnv(cfg: PortfolioEnvConfig = {}): PortfolioEnv {
  const chainId = cfg.chainId ?? 8453
  const chain = getChain(chainId)
  const blockNumber = cfg.blockNumber ?? 777_777n
  const feeTo = cfg.feeTo ?? ZERO_ADDRESS
  const pairs = cfg.pairs ?? []
  const wrapperDecimals = cfg.wrapperDecimals ?? 18

  const pairByAddress = new Map<string, PortfolioPairConfig>()
  const wrapperByAddress = new Map<string, PortfolioPairConfig>()
  const collectionByAddress = new Map<string, PortfolioPairConfig>()
  const baseInfoByAddress = new Map<string, { readonly decimals: number; readonly symbol: string }>()
  for (const p of pairs) {
    pairByAddress.set(p.pair.toLowerCase(), p)
    wrapperByAddress.set(p.wrapper.toLowerCase(), p)
    collectionByAddress.set(p.collection.toLowerCase(), p)
    const baseAddress = (p.base?.address ?? chain.quoteToken).toLowerCase()
    baseInfoByAddress.set(baseAddress, {
      decimals: p.base?.decimals ?? chain.quoteDecimals,
      symbol: p.base?.symbol ?? chain.nativeSymbol,
    })
  }

  const calls: RecordedCall[] = []
  let inFlight = 0
  let maxSeen = 0

  function resolveOne(call: { readonly address: string; readonly functionName: string; readonly args?: readonly unknown[] }): ReadResult {
    const { address, functionName } = call
    const args = argsOf(call.args)
    let matchedRole = false

    // Factory
    if (isAddr(address, chain.factory)) {
      matchedRole = true
      switch (functionName) {
        case 'feeTo':
          return { status: 'success', result: feeTo }
        case 'getPair': {
          // Keyed by BOTH args — a wrapper can back two pools (native + ERC-20 base).
          const wrapperArg = String(args[0]).toLowerCase()
          const baseArg = String(args[1] ?? '').toLowerCase()
          const cfgPair = pairs.find((p) => p.wrapper.toLowerCase() === wrapperArg && (p.base?.address ?? chain.quoteToken).toLowerCase() === baseArg)
          if (cfgPair === undefined) return { status: 'success', result: ZERO_ADDRESS }
          const listed = cfgPair.factoryListed ?? true
          return { status: 'success', result: listed ? cfgPair.pair : chain.factory }
        }
        case 'getCollection': {
          const addrArg = String(args[0])
          const override = lookupCI(cfg.factoryCollection, addrArg)
          if (override !== undefined) return { status: 'success', result: override }
          const cfgPair = wrapperByAddress.get(addrArg.toLowerCase())
          return { status: 'success', result: cfgPair?.collection ?? ZERO_ADDRESS }
        }
      }
    }

    // Pair (UniswapV2Pair)
    const pairCfg = pairByAddress.get(address.toLowerCase())
    if (pairCfg !== undefined) {
      matchedRole = true
      const wrapperIsToken0 = pairCfg.wrapperIsToken0 ?? true
      const baseAddress = pairCfg.base?.address ?? chain.quoteToken
      switch (functionName) {
        case 'token0':
          if (pairCfg.failLoad) return { status: 'failure' }
          return { status: 'success', result: wrapperIsToken0 ? pairCfg.wrapper : baseAddress }
        case 'token1':
          if (pairCfg.failLoad) return { status: 'failure' }
          return { status: 'success', result: wrapperIsToken0 ? baseAddress : pairCfg.wrapper }
        case 'getReserves': {
          const reserves = pairCfg.reserves ?? { base: 0n, wnft: 0n }
          const [r0, r1] = wrapperIsToken0 ? [reserves.wnft, reserves.base] : [reserves.base, reserves.wnft]
          return { status: 'success', result: [r0, r1, 0] }
        }
        case 'totalSupply':
          return { status: 'success', result: pairCfg.totalSupply ?? 0n }
        case 'balanceOf': {
          if (pairCfg.failScan) return { status: 'failure' }
          const lp = lookupCI(pairCfg.lp, String(args[0])) ?? 0n
          return { status: 'success', result: lp }
        }
      }
    }

    // Wrapper (WERC721)
    const wrapperCfg = wrapperByAddress.get(address.toLowerCase())
    if (wrapperCfg !== undefined) {
      matchedRole = true
      switch (functionName) {
        case 'collection':
          return { status: 'success', result: wrapperCfg.collection }
        case 'balanceOf': {
          const arg0 = String(args[0])
          if (isAddr(arg0, wrapperCfg.pair)) {
            const balances = wrapperCfg.balances ?? wrapperCfg.reserves ?? { base: 0n, wnft: 0n }
            return { status: 'success', result: balances.wnft }
          }
          if ((cfg.failWnftBalanceOf ?? []).some((w) => isAddr(address, w))) return { status: 'failure' }
          const perOwner = lookupCI(cfg.wnft, address)
          return { status: 'success', result: lookupCI(perOwner, arg0) ?? 0n }
        }
        case 'decimals':
          return { status: 'success', result: wrapperDecimals }
      }
    }

    // Base token (ERC-20 or the chain's native quote token)
    const baseInfo = baseInfoByAddress.get(address.toLowerCase())
    if (baseInfo !== undefined) {
      matchedRole = true
      switch (functionName) {
        case 'decimals':
          return { status: 'success', result: baseInfo.decimals }
        case 'symbol':
          return { status: 'success', result: baseInfo.symbol }
        case 'balanceOf': {
          const arg0 = String(args[0]).toLowerCase()
          const owning = pairs.find((p) => p.pair.toLowerCase() === arg0)
          const balances = owning?.balances ?? owning?.reserves ?? { base: 0n, wnft: 0n }
          return { status: 'success', result: balances.base }
        }
        case 'collection':
          // Only the honest WERC721 answers `collection()` — a plain base token never does.
          return { status: 'failure' }
      }
    }

    // The raw ERC-721 collection (never the wrapper)
    const collectionCfg = collectionByAddress.get(address.toLowerCase())
    if (collectionCfg !== undefined) {
      matchedRole = true
      switch (functionName) {
        case 'balanceOf': {
          if (cfg.failErc721) return { status: 'failure' }
          const perOwner = lookupCI(cfg.erc721, address)
          return { status: 'success', result: lookupCI(perOwner, String(args[0])) ?? 0n }
        }
        case 'name':
          return collectionCfg.onChainName !== undefined ? { status: 'success', result: collectionCfg.onChainName } : { status: 'failure' }
        case 'symbol':
          return collectionCfg.onChainSymbol !== undefined ? { status: 'success', result: collectionCfg.onChainSymbol } : { status: 'failure' }
      }
    }

    if (matchedRole) return { status: 'failure' }
    throw new Error(`buildPortfolioEnv: unmocked call ${functionName} on ${address} (no configured role owns this address)`)
  }

  const multicall = vi.fn(
    async (params: {
      readonly contracts: readonly { readonly address: string; readonly functionName: string; readonly args?: readonly unknown[] }[]
      readonly blockNumber?: bigint
    }): Promise<readonly ReadResult[]> => {
      inFlight += 1
      maxSeen = Math.max(maxSeen, inFlight)
      try {
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
        const results: ReadResult[] = []
        for (const call of params.contracts) {
          calls.push({ address: call.address, functionName: call.functionName, args: argsOf(call.args), blockNumber: params.blockNumber })
          results.push(resolveOne(call))
        }
        return results
      } finally {
        inFlight -= 1
      }
    },
  )

  const allRows: SubgraphPair[] = [...pairs.map((p) => buildNftPoolRow(p, chain)), ...(cfg.extraRows ?? [])]

  const pools = vi.fn(async (args?: { readonly first?: number; readonly skip?: number }) => {
    const skip = args?.skip ?? 0
    const first = args?.first ?? allRows.length
    return {
      data: allRows.slice(skip, skip + first),
      asOfBlock: cfg.asOfBlock ?? blockNumber,
      lagSeconds: cfg.lagSeconds ?? 0,
      stale: cfg.stale ?? false,
      revalidating: false,
    }
  })

  const getBlockNumber = vi.fn(async () => blockNumber)
  const publicClient = {
    multicall,
    simulateContract: vi.fn(),
    estimateContractGas: vi.fn(),
    getBalance: vi.fn(),
    getBlockNumber,
    readContract: vi.fn(),
  } as unknown as PublicClient

  const providers = resolveProviders({ chainId, publicClient, providers: cfg.providers } as unknown as SnfClientConfig)

  const ctx = {
    config: { chainId, publicClient },
    chain,
    publicClient,
    providers,
    transport: {
      pools,
      pairById: vi.fn(async () => {
        throw new Error('not used by portfolio tests')
      }),
      inventory: vi.fn(),
      meta: vi.fn(),
      clear: vi.fn(),
    },
    nextTxInvalidationVersion: () => 1,
  } as unknown as SnfClientContext

  return {
    ctx,
    multicall,
    getBlockNumber,
    pools,
    calls: () => calls,
    maxInFlight: () => maxSeen,
  }
}
