import type { Abi } from 'viem'

import { FACTORY_ABI } from '../abis/UniswapV2Factory'
import { PAIR_ABI } from '../abis/UniswapV2Pair'
import { toSnfError } from '../errors'
import { toPoolAmount } from '../format'
import { lpPositionFromState } from '../liquidity/lpPosition'
import { loadPairState } from '../liquidity/poolState'
import type { PairPoolState } from '../liquidity/poolState.types'
import type { SnfClientContext } from '../types/client.types'
import type { PortfolioPosition, PortfolioPositions, PositionSkip } from '../types/portfolio.types'
import { resolveLabels } from './labels'
import { nftPoolSet } from './poolSet'
import type { NftPoolEntry } from './poolSet.types'
import { mapWithConcurrency, normalizeAddress, PORTFOLIO_CONCURRENCY } from './shared'
import { readUsdPrices, toUsd } from './usd'

/**
 * `positions(owner)` — every SnF LP position this owner holds on the client's chain,
 * described at ONE block: a position in this result is a description of one chain
 * moment, not a mix of several. Discovery starts from the shared `nftPoolSet` (the
 * subgraph's `isNFTPool` pre-filter); a single pinned multicall then scans every
 * candidate pair's `balanceOf(owner)` plus `Factory.feeTo()`; only pairs with a
 * non-zero balance go on to `loadPairState` (the Factory re-derivation and on-chain
 * `collection()` probe stay the real gate) + the pure `lpPositionFromState` — no
 * duplicated burn math.
 *
 * `valueInBase` is `2 × underlying.base` at the pool's mid price — an honest mark,
 * not what a withdrawal would actually pay out (an exit pays AMM slippage on
 * `quoteRemoveLiquidity`, then `quoteSell` for a `nft`-mode redemption). A failure on
 * one pair — an unreadable scan read, a spoofed pair, a live protocol fee, an
 * unreadable `loadPairState` — lands in `skipped` with its error code and never fails
 * the whole call; only a pool-set failure or a thrown scan multicall rejects. A
 * wallet across several chains is read with one client per chain — this method never
 * spans more than the client's own chain.
 */

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

interface Call {
  readonly address: `0x${string}`
  readonly abi: Abi
  readonly functionName: string
  readonly args: readonly unknown[]
}
type CallResult = { readonly status: 'success' | 'failure'; readonly result?: unknown }

interface Loaded {
  readonly entry: NftPoolEntry
  readonly state: PairPoolState
  readonly position: ReturnType<typeof lpPositionFromState>
}

function subgraphHintFor(
  entry: NftPoolEntry,
  state: PairPoolState,
): { readonly subgraphName?: string | undefined; readonly subgraphSymbol?: string | undefined } {
  if (entry.collection.toLowerCase() !== state.collection.toLowerCase()) return {}
  return { subgraphName: entry.subgraphName, subgraphSymbol: entry.subgraphSymbol }
}

function compareBaseAddress(a: PortfolioPosition, b: PortfolioPosition): number {
  const left = (a.baseToken.address ?? '').toLowerCase()
  const right = (b.baseToken.address ?? '').toLowerCase()
  return left < right ? -1 : left > right ? 1 : 0
}

/** Native-base first; then by base token address; within one base token by
 * `valueInBase.value` descending; ties broken by pair address. */
function sortPositions(a: PortfolioPosition, b: PortfolioPosition): number {
  if (a.baseToken.isNative !== b.baseToken.isNative) return a.baseToken.isNative ? -1 : 1
  const byAddress = compareBaseAddress(a, b)
  if (byAddress !== 0) return byAddress
  if (a.valueInBase.value !== b.valueInBase.value) return a.valueInBase.value > b.valueInBase.value ? -1 : 1
  const leftPair = a.pair.toLowerCase()
  const rightPair = b.pair.toLowerCase()
  return leftPair < rightPair ? -1 : leftPair > rightPair ? 1 : 0
}

export async function positions(ctx: SnfClientContext, owner: `0x${string}`): Promise<PortfolioPositions> {
  const normalizedOwner = normalizeAddress(owner, 'owner')
  const poolSet = await nftPoolSet(ctx)
  const blockNumber = await ctx.publicClient.getBlockNumber()

  const empty = (skipped: readonly PositionSkip[] = []): PortfolioPositions => ({
    chainId: ctx.chain.chainId,
    owner: normalizedOwner,
    blockNumber,
    positions: [],
    skipped,
    poolSet: poolSet.freshness,
  })

  if (poolSet.pools.length === 0) return empty()

  // ── One pinned multicall: every candidate's own LP balance, plus the live
  // protocol-fee flag — never one round trip per pair. ──────────────────────────
  const scanContracts: Call[] = [
    ...poolSet.pools.map((entry) => ({ address: entry.pair, abi: PAIR_ABI, functionName: 'balanceOf', args: [normalizedOwner] })),
    { address: ctx.chain.factory, abi: FACTORY_ABI, functionName: 'feeTo', args: [] },
  ]
  const scan: readonly CallResult[] = await ctx.publicClient.multicall({
    contracts: scanContracts,
    allowFailure: true,
    multicallAddress: ctx.chain.multicall3,
    batchSize: 0,
    blockNumber,
  })

  const skipped: PositionSkip[] = []
  const held: NftPoolEntry[] = []
  poolSet.pools.forEach((entry, i) => {
    const result = scan[i]
    if (result?.status !== 'success') {
      skipped.push({ pair: entry.pair, code: 'NO_ROUTE' })
      return
    }
    if ((result.result as bigint) > 0n) held.push(entry)
  })

  const feeToResult = scan[poolSet.pools.length]
  const feeTo = feeToResult?.status === 'success' ? (feeToResult.result as string) : undefined
  if (feeTo !== undefined && feeTo.toLowerCase() !== ZERO_ADDRESS) {
    // A live protocol fee breaks the fee-off burn mirror for every held pair — none
    // of them can be priced honestly, so none are loaded.
    for (const entry of held) skipped.push({ pair: entry.pair, code: 'QUOTE_RECONCILIATION_FAILED' })
    return empty(skipped)
  }

  const loaded = await mapWithConcurrency(held, PORTFOLIO_CONCURRENCY, async (entry): Promise<Loaded | undefined> => {
    try {
      const state = await loadPairState(ctx, { pair: entry.pair, owner: normalizedOwner, blockNumber })
      const position = lpPositionFromState(state, normalizedOwner)
      return { entry, state, position }
    } catch (e) {
      skipped.push({ pair: entry.pair, code: toSnfError(e).code })
      return undefined
    }
  })
  const successes = loaded.filter((x): x is Loaded => x !== undefined)

  if (successes.length === 0) return empty(skipped)

  const labels = await resolveLabels(
    ctx,
    successes.map(({ entry, state }) => ({ collection: state.collection, ...subgraphHintFor(entry, state) })),
    blockNumber,
  )
  const usdPrices = await readUsdPrices(
    ctx,
    successes.map(({ state }) => state.baseToken),
  )

  const enriched: PortfolioPosition[] = successes.map(({ state, position }) => {
    const valueInBase = toPoolAmount(state.baseToken, 2n * position.underlying.base.value)
    const priceKey = state.baseToken.address === null ? 'native' : state.baseToken.address.toLowerCase()
    return {
      ...position,
      chainId: ctx.chain.chainId,
      collection: state.collection,
      wrapper: state.wrapper,
      baseToken: state.baseToken,
      labels: labels.get(state.collection.toLowerCase())!,
      valueInBase,
      valuation: 'mid',
      valueUsd: toUsd(valueInBase, usdPrices.get(priceKey)),
    }
  })

  return {
    chainId: ctx.chain.chainId,
    owner: normalizedOwner,
    blockNumber,
    positions: enriched.sort(sortPositions),
    skipped,
    poolSet: poolSet.freshness,
  }
}
