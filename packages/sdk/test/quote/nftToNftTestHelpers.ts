import type { PublicClient } from 'viem'
import { vi } from 'vitest'

import { getChain } from '../../src/chains/registry'
import type { SnfClientContext } from '../../src/types/client.types'

/**
 * Two-collection fixture builder for `test/quote/{quoteNftToNft,nftToNft.parity}.test.ts`
 * — `quoteNftToNft` resolves TWO independent collections (via `resolveCollection` +,
 * for the buy leg, `poolInventory`) against the SAME `ctx`, so `test/quote/testHelpers.
 * ts`'s single-collection, batch-SHAPE-keyed dispatcher cannot distinguish
 * "the sell collection's `name()`" from "the buy collection's `name()`" — both calls
 * have the identical shape. This dispatcher resolves every multicall entry ONE AT A
 * TIME by its `address`/`args`, which naturally disambiguates the two collections (not
 * itself a `*.test.ts` — same non-test-file convention as `testHelpers.ts`, see
 * , Deviations).
 */

export type ReadResult = { readonly status: 'success' | 'failure'; readonly result?: unknown }

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as `0x${string}`
const DEFAULT_ROYALTY_CAP_E18 = 10n ** 18n

export interface RoyaltyLine {
  readonly tokenId: string
  readonly receiver: `0x${string}`
  readonly amount: bigint
}

export interface LegConfig {
  readonly pair: `0x${string}`
  readonly wrapper: `0x${string}`
  readonly collection: `0x${string}`
  readonly name?: string
  readonly symbol?: string
  readonly wrapperIsToken0?: boolean
  readonly reserves: { readonly base: bigint; readonly wnft: bigint }
  readonly wrapperDecimals?: number
  readonly royaltyCapE18?: bigint
  /** Overrides the pool's base token away from the chain's native `quoteToken` — used
   * ONLY by the different-base fixture (`evaluateRouteBlock`'s `'different-base'`
   * path). When set, the native `quoteToken` candidate resolves to no pair and this
   * address is discovered instead via a synthetic subgraph enrichment hint. */
  readonly baseToken?: `0x${string}`
  readonly baseSymbol?: string
  readonly baseDecimals?: number
  /** `wnftUnitsFromCount(tokenIds.length)` — the plain leg's `amountOut`/`amountIn`. */
  readonly units: bigint
  /** The plain (non-`Collection`) Router read on the wrapper leg. */
  readonly poolLeg: bigint
  /** The `*Collection` Router's own gross (buy) / net (sell) answer. */
  readonly routerTotal: bigint
  /** Round-2 `royaltyInfo` results, one per real tokenId, in order. */
  readonly perId: readonly RoyaltyLine[]
  /** `poolInventory`'s subgraph-fallback candidate list (buy leg only). */
  readonly candidateTokenIds?: readonly string[]
  readonly redemptionLocked?: boolean
}

export interface TwoLegConfig {
  readonly chainId?: number
  readonly quoteToken?: `0x${string}`
  readonly marketplaceFeeE18: bigint
  readonly sell: LegConfig
  readonly buy: LegConfig
}

export interface TwoLegEnv {
  readonly ctx: SnfClientContext
  readonly multicall: ReturnType<typeof vi.fn>
  calls(): readonly { readonly contracts: readonly { readonly functionName: string; readonly args: readonly unknown[] }[] }[]
}

interface PairDispatch {
  readonly token0: `0x${string}`
  readonly token1: `0x${string}`
  readonly reserve0: bigint
  readonly reserve1: bigint
}

function pairDispatch(leg: LegConfig, quoteToken: `0x${string}`): PairDispatch {
  const base = leg.baseToken ?? quoteToken
  const wrapperIsToken0 = leg.wrapperIsToken0 ?? false
  const [token0, token1] = wrapperIsToken0 ? [leg.wrapper, base] : [base, leg.wrapper]
  const [reserve0, reserve1] = wrapperIsToken0 ? [leg.reserves.wnft, leg.reserves.base] : [leg.reserves.base, leg.reserves.wnft]
  return { token0, token1, reserve0, reserve1 }
}

function eqAddr(a: string, b: `0x${string}`): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

export function buildTwoLegEnv(cfg: TwoLegConfig): TwoLegEnv {
  const chainId = cfg.chainId ?? 8453
  const chain = getChain(chainId)
  const quoteToken = cfg.quoteToken ?? chain.quoteToken
  const sellDispatch = pairDispatch(cfg.sell, quoteToken)
  const buyDispatch = pairDispatch(cfg.buy, quoteToken)
  const sellCandidates = cfg.sell.candidateTokenIds ?? cfg.sell.perId.map((p) => p.tokenId)
  const buyCandidates = cfg.buy.candidateTokenIds ?? cfg.buy.perId.map((p) => p.tokenId)

  function royaltyInfoFor(collection: `0x${string}`, tokenId: bigint): ReadResult {
    const leg = eqAddr(collection, cfg.sell.collection) ? cfg.sell : eqAddr(collection, cfg.buy.collection) ? cfg.buy : undefined
    const line = leg?.perId.find((p) => BigInt(p.tokenId) === tokenId)
    if (!line) return { status: 'success', result: [ZERO_ADDRESS, 0n] }
    return { status: 'success', result: [line.receiver, line.amount] }
  }

  function resolveEntry(entry: { readonly address: `0x${string}`; readonly functionName: string; readonly args: readonly unknown[] }): ReadResult {
    const { address, functionName, args } = entry

    if (functionName === 'supportsInterface') {
      // Forces poolInventory's ERC721Enumerable fast path to miss (subgraph fallback)
      // and resolveRoyalty's IERC2981 probe to miss — neither result feeds
      // quoteNftToNft's own math (see this file's header).
      return { status: 'success', result: false }
    }
    if (functionName === 'getWrapper') {
      const collectionArg = args[0] as string
      if (eqAddr(collectionArg, cfg.sell.collection)) return { status: 'success', result: cfg.sell.wrapper }
      if (eqAddr(collectionArg, cfg.buy.collection)) return { status: 'success', result: cfg.buy.wrapper }
      return { status: 'failure' }
    }
    if (functionName === 'name') {
      if (eqAddr(address, cfg.sell.collection)) return { status: 'success', result: cfg.sell.name ?? 'Sell Collection' }
      if (eqAddr(address, cfg.buy.collection)) return { status: 'success', result: cfg.buy.name ?? 'Buy Collection' }
      return { status: 'failure' }
    }
    if (functionName === 'symbol') {
      if (eqAddr(address, cfg.sell.collection)) return { status: 'success', result: cfg.sell.symbol ?? 'SELL' }
      if (eqAddr(address, cfg.buy.collection)) return { status: 'success', result: cfg.buy.symbol ?? 'BUY' }
      if (cfg.sell.baseToken && eqAddr(address, cfg.sell.baseToken)) return { status: 'success', result: cfg.sell.baseSymbol ?? 'SELLBASE' }
      if (cfg.buy.baseToken && eqAddr(address, cfg.buy.baseToken)) return { status: 'success', result: cfg.buy.baseSymbol ?? 'BUYBASE' }
      return { status: 'failure' }
    }
    if (functionName === 'getPair') {
      const [wrapperArg, baseArg] = args as [string, string]
      const sellBase = cfg.sell.baseToken ?? quoteToken
      const buyBase = cfg.buy.baseToken ?? quoteToken
      if (eqAddr(wrapperArg, cfg.sell.wrapper) && eqAddr(baseArg, sellBase)) return { status: 'success', result: cfg.sell.pair }
      if (eqAddr(wrapperArg, cfg.buy.wrapper) && eqAddr(baseArg, buyBase)) return { status: 'success', result: cfg.buy.pair }
      return { status: 'success', result: ZERO_ADDRESS }
    }
    if (functionName === 'collection') {
      // WERC721.collection() — resolveCollection's batchB[0] AND poolInventory's
      // per-pair-slot probe on both token0/token1 (only the wrapper slot succeeds).
      if (eqAddr(address, cfg.sell.wrapper)) return { status: 'success', result: cfg.sell.collection }
      if (eqAddr(address, cfg.buy.wrapper)) return { status: 'success', result: cfg.buy.collection }
      return { status: 'failure' }
    }
    if (functionName === 'getReserves') {
      if (eqAddr(address, cfg.sell.pair)) return { status: 'success', result: [sellDispatch.reserve0, sellDispatch.reserve1, 0] }
      if (eqAddr(address, cfg.buy.pair)) return { status: 'success', result: [buyDispatch.reserve0, buyDispatch.reserve1, 0] }
      return { status: 'failure' }
    }
    if (functionName === 'token0') {
      if (eqAddr(address, cfg.sell.pair)) return { status: 'success', result: sellDispatch.token0 }
      if (eqAddr(address, cfg.buy.pair)) return { status: 'success', result: buyDispatch.token0 }
      return { status: 'failure' }
    }
    if (functionName === 'token1') {
      if (eqAddr(address, cfg.sell.pair)) return { status: 'success', result: sellDispatch.token1 }
      if (eqAddr(address, cfg.buy.pair)) return { status: 'success', result: buyDispatch.token1 }
      return { status: 'failure' }
    }
    if (functionName === 'decimals') {
      if (eqAddr(address, cfg.sell.wrapper)) return { status: 'success', result: cfg.sell.wrapperDecimals ?? 18 }
      if (eqAddr(address, cfg.buy.wrapper)) return { status: 'success', result: cfg.buy.wrapperDecimals ?? 18 }
      if (cfg.sell.baseToken && eqAddr(address, cfg.sell.baseToken)) return { status: 'success', result: cfg.sell.baseDecimals ?? 18 }
      if (cfg.buy.baseToken && eqAddr(address, cfg.buy.baseToken)) return { status: 'success', result: cfg.buy.baseDecimals ?? 18 }
      return { status: 'failure' }
    }
    if (functionName === 'marketplaceFee') {
      // Router.marketplaceFee() takes no args — genuinely chain-global, not per-leg.
      return { status: 'success', result: cfg.marketplaceFeeE18 }
    }
    if (functionName === 'royaltyFeeCap') {
      const collectionArg = args[0] as string
      if (eqAddr(collectionArg, cfg.sell.collection)) return { status: 'success', result: cfg.sell.royaltyCapE18 ?? DEFAULT_ROYALTY_CAP_E18 }
      if (eqAddr(collectionArg, cfg.buy.collection)) return { status: 'success', result: cfg.buy.royaltyCapE18 ?? DEFAULT_ROYALTY_CAP_E18 }
      return { status: 'success', result: DEFAULT_ROYALTY_CAP_E18 }
    }
    if (functionName === 'getAmountsInCollection') {
      // args = [tokenIdsBig, [base, collection], false] — the buy leg only.
      const collectionArg = (args[1] as readonly string[])[1] as string
      if (eqAddr(collectionArg, cfg.buy.collection)) return { status: 'success', result: [cfg.buy.routerTotal, cfg.buy.units] }
      return { status: 'failure' }
    }
    if (functionName === 'getAmountsOutCollection') {
      // args = [tokenIdsBig, [collection, base], false] — the sell leg only.
      const collectionArg = (args[1] as readonly string[])[0] as string
      if (eqAddr(collectionArg, cfg.sell.collection)) return { status: 'success', result: [cfg.sell.units, cfg.sell.routerTotal] }
      return { status: 'failure' }
    }
    if (functionName === 'getAmountsIn') {
      // Plain leg, args = [amount, [base, wrapper]] — the buy leg's own round1 read.
      const wrapperArg = (args[1] as readonly string[])[1] as string
      if (eqAddr(wrapperArg, cfg.buy.wrapper)) return { status: 'success', result: [cfg.buy.poolLeg, cfg.buy.units] }
      return { status: 'failure' }
    }
    if (functionName === 'getAmountsOut') {
      // Plain leg, args = [amount, [wrapper, base]] — the sell leg's own round1 read.
      const wrapperArg = (args[1] as readonly string[])[0] as string
      if (eqAddr(wrapperArg, cfg.sell.wrapper)) return { status: 'success', result: [cfg.sell.units, cfg.sell.poolLeg] }
      return { status: 'failure' }
    }
    if (functionName === 'royaltyInfo') {
      const [tokenId] = args as [bigint, bigint]
      return royaltyInfoFor(address, tokenId)
    }
    throw new Error(`buildTwoLegEnv: unmocked multicall entry [${functionName}] on ${address}`)
  }

  const calls: { readonly contracts: readonly { readonly functionName: string; readonly args: readonly unknown[] }[] }[] = []
  const multicall = vi.fn(
    async (params: {
      readonly contracts: readonly { readonly address: `0x${string}`; readonly functionName: string; readonly args: readonly unknown[] }[]
    }): Promise<readonly ReadResult[]> => {
      calls.push(params)
      return params.contracts.map((entry) => resolveEntry(entry))
    },
  )

  const simulateContract = vi.fn(async (params: { readonly address: `0x${string}` }) => {
    const leg = eqAddr(params.address, cfg.sell.collection) ? cfg.sell : eqAddr(params.address, cfg.buy.collection) ? cfg.buy : undefined
    if (leg?.redemptionLocked) {
      throw new Error('execution reverted: transfer role denied')
    }
    return { result: undefined }
  })

  const publicClient = {
    multicall,
    simulateContract,
    getBlockNumber: vi.fn(async () => 999_999n),
  } as unknown as PublicClient

  function inventoryFor(wrapper: `0x${string}`) {
    const ids = eqAddr(wrapper, cfg.sell.wrapper) ? sellCandidates : eqAddr(wrapper, cfg.buy.wrapper) ? buyCandidates : []
    return {
      data: ids.length > 0 ? { id: wrapper, symbol: 'W', name: 'W', decimals: 18, wrapping: true, tokenIds: ids } : null,
      asOfBlock: 999_999n,
      lagSeconds: 0,
      stale: false,
      revalidating: false,
    }
  }

  const ctx = {
    config: { chainId, publicClient },
    chain,
    publicClient,
    providers: {},
    transport: {
      pools: vi.fn(async () => {
        // Only used by the different-base fixture: discoverEnrichment scans this
        // list for a pair mentioning the wrapper it's resolving, to discover a
        // second (non-native) base candidate address. Absent that need, the real
        // call site catches a throw and treats enrichment as best-effort-skipped —
        // an empty, always-succeeding list is equivalent here and simpler to reason
        // about than conditionally throwing.
        const extra = [cfg.sell, cfg.buy]
          .filter((leg) => leg.baseToken !== undefined)
          .map((leg) => ({
            token0: { id: leg.wrapper, collection: null },
            token1: { id: leg.baseToken as `0x${string}`, collection: null },
          }))
        return { data: extra, asOfBlock: 999_999n, lagSeconds: 0, stale: false, revalidating: false }
      }),
      pairById: vi.fn(async () => {
        throw new Error('subgraph down (reserveUSD enrichment is best-effort)')
      }),
      inventory: vi.fn(async (wrapper: `0x${string}`) => inventoryFor(wrapper)),
      meta: vi.fn(),
      clear: vi.fn(),
    },
    nextTxInvalidationVersion: () => 1,
  } as unknown as SnfClientContext

  return { ctx, multicall, calls: () => calls }
}
