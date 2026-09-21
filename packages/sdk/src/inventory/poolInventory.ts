import { getAddress } from 'viem'
import type { Abi } from 'viem'

import { ERC721_ABI } from '../abis/ERC721'
import { PAIR_ABI } from '../abis/UniswapV2Pair'
import { WERC721_ABI } from '../abis/WERC721'
import { assertParam } from '../errors'
import { resolveWrapperSide } from '../routing/nftRoutePaths'
import { availableCountFromReserve, normalizeTokenIds } from './availability'
import { ERC721_ENUMERABLE_INTERFACE_ID, readEnumerableTokenIds } from './enumerable'
import type { TokenRef } from '../types/amount.types'
import type { SnfClientContext } from '../types/client.types'
import type { PoolInventory } from '../types/inventory.types'

/**
 * `poolInventory(pair)` — candidate tokenIds a pool currently holds, the buyable
 * ceiling, and freshness (R7; 54-SPEC.md). "The index proposes, the chain decides":
 * `availableCount` is ALWAYS recomputed from the live `getReserves` read, never taken
 * from a partner-supplied provider or from the subgraph — a provider can propose ids,
 * it can never raise the ceiling (T-54-56). This module never trusts `tokenIds` as
 * transaction-authoritative either; `plan.preflight()` (plan 14) re-asserts pool
 * ownership of the exact ids in the signing frame.
 */

/** The subgraph's `currency.tokenIds` field does not paginate — the whole array comes
 * back regardless of length, so this module caps what it CONSUMES downstream rather
 * than relying on the query to truncate, and reports `truncated` when it does. */
const MAX_CONSUMED_IDS = 1000

/** Loosely-typed multicall shape — see `collection/royalty.ts`'s identical comment:
 * viem's per-position tuple inference cannot precisely type-check this package's
 * batches. */
interface Call {
  readonly address: `0x${string}`
  readonly abi: Abi
  readonly functionName: string
  readonly args: readonly unknown[]
}
type CallResult = { readonly status: 'success' | 'failure'; readonly result?: unknown }

export async function poolInventory(ctx: SnfClientContext, pair: `0x${string}`): Promise<PoolInventory> {
  assertParam(/^0x[0-9a-fA-F]{40}$/.test(pair), 'poolInventory requires a well-formed 0x pair address', {
    field: 'pair',
  })
  const pairAddress = getAddress(pair)

  // Step 1a — token0()/token1()/getReserves() on the pair, ONE multicall. The
  // wrapper's own `collection()` cannot join this same batch: it is called on
  // whichever of token0/token1 turns out to BE the wrapper, an address this batch's
  // own results are what determine — a genuine sequential dependency, not an
  // oversight (documented deviation from the plan's literal "one multicall" framing,
  // see snf-54-11-SUMMARY.md).
  const pairContracts: readonly Call[] = [
    { address: pairAddress, abi: PAIR_ABI, functionName: 'token0', args: [] },
    { address: pairAddress, abi: PAIR_ABI, functionName: 'token1', args: [] },
    { address: pairAddress, abi: PAIR_ABI, functionName: 'getReserves', args: [] },
  ]
  const pairResults: readonly CallResult[] = await ctx.publicClient.multicall({
    contracts: pairContracts,
    allowFailure: true,
    multicallAddress: ctx.chain.multicall3,
    batchSize: 0,
  })
  // Extracted into named locals BEFORE narrowing — `noUncheckedIndexedAccess` does not
  // narrow a re-computed `arr[i]` expression across statements, only a stable
  // identifier (the same discipline `collection/resolveCollection.ts` follows).
  const token0Result = pairResults[0]
  const token1Result = pairResults[1]
  const reservesResult = pairResults[2]
  assertParam(
    token0Result?.status === 'success' && token1Result?.status === 'success' && reservesResult?.status === 'success',
    'poolInventory could not read token0/token1/getReserves for this pair',
    { field: 'pair', value: pairAddress },
  )
  const token0 = token0Result.result as `0x${string}`
  const token1 = token1Result.result as `0x${string}`
  const [reserve0, reserve1] = reservesResult.result as readonly [bigint, bigint, number]

  // Step 1b — which slot is the wrapper: probe `WERC721.collection()` on BOTH token0
  // AND token1 (never assume token1 — CLAUDE.md). Exactly one call succeeds (only a
  // WERC721 contract exposes `collection()`); that outcome is fed to
  // `resolveWrapperSide` as `discrete0`/`discrete1` — the SAME signal the subgraph
  // supplies elsewhere — so this module never re-derives the wrapper side by any
  // OTHER address comparison of its own.
  const collectionProbe: readonly Call[] = [
    { address: token0, abi: WERC721_ABI, functionName: 'collection', args: [] },
    { address: token1, abi: WERC721_ABI, functionName: 'collection', args: [] },
  ]
  const collectionResults: readonly CallResult[] = await ctx.publicClient.multicall({
    contracts: collectionProbe,
    allowFailure: true,
    multicallAddress: ctx.chain.multicall3,
    batchSize: 0,
  })
  const discrete0 = collectionResults[0]?.status === 'success'
  const discrete1 = collectionResults[1]?.status === 'success'
  assertParam(
    discrete0 || discrete1,
    'poolInventory: neither pair slot exposes WERC721.collection() — this is not an SnF NFT pool',
    { field: 'pair', value: pairAddress },
  )
  const fallbackBase: TokenRef = { address: discrete0 ? token1 : token0, symbol: 'BASE', decimals: 18, isNative: false }
  const { wrapperIsToken0 } = resolveWrapperSide({
    pair: pairAddress,
    token0,
    token1,
    discrete0,
    discrete1,
    baseToken: fallbackBase,
  })
  const wrapper = wrapperIsToken0 ? token0 : token1
  const collection = (wrapperIsToken0 ? collectionResults[0] : collectionResults[1])?.result as `0x${string}`
  const reserveWnft = wrapperIsToken0 ? reserve0 : reserve1

  // Step 2 — the buyable ceiling. Computed HERE, once, from the live reserve — every
  // return below reuses this same value; nothing downstream may override it.
  const availableCount = availableCountFromReserve(reserveWnft)

  // Step 3 — a partner-supplied provider replaces BOTH the enumerable and subgraph
  // paths below, but never this ceiling (T-54-56).
  const provider = ctx.providers.poolInventory
  if (provider) {
    const provided = await provider.getPoolInventory(pairAddress, ctx.chain.chainId)
    if (provided) {
      return { ...provided, tokenIds: normalizeTokenIds(provided.tokenIds), availableCount }
    }
  }

  // Step 4 — the ERC721Enumerable fast path.
  const supportsResults: readonly CallResult[] = await ctx.publicClient.multicall({
    contracts: [
      { address: collection, abi: ERC721_ABI, functionName: 'supportsInterface', args: [ERC721_ENUMERABLE_INTERFACE_ID] },
    ],
    allowFailure: true,
    multicallAddress: ctx.chain.multicall3,
    batchSize: 0,
  })
  const supportsResult = supportsResults[0]
  const enumerableSupported = supportsResult?.status === 'success' && supportsResult.result === true

  if (enumerableSupported) {
    const whole = reserveWnft / 10n ** 18n
    assertParam(whole <= BigInt(Number.MAX_SAFE_INTEGER), 'pool holds more wrapped units than can be enumerated', {
      field: 'reserveWnft',
    })
    const { tokenIds, truncated, warnings } = await readEnumerableTokenIds(ctx, {
      collection,
      holder: wrapper,
      balance: Number(whole),
    })
    const asOfBlock = await ctx.publicClient.getBlockNumber()
    return {
      tokenIds: normalizeTokenIds(tokenIds),
      availableCount,
      asOfBlock,
      lagSeconds: 0,
      stale: false,
      source: 'enumerable',
      truncated,
      warnings,
    }
  }

  // Step 5 — the subgraph fallback. Freshness is carried through VERBATIM from the
  // same POST that returned the ids — never recomputed, never reset. A transport
  // rejection (e.g. `UPSTREAM_DEGRADED`) propagates unchanged; it is never caught
  // here and turned into an empty inventory (prohibition: "never silently OK").
  const wrapperLower = wrapper.toLowerCase() as `0x${string}`
  const { data: currency, asOfBlock, lagSeconds, stale } = await ctx.transport.inventory(wrapperLower)
  const rawIds = currency?.tokenIds ?? []
  const truncated = rawIds.length > MAX_CONSUMED_IDS
  const consumed = truncated ? rawIds.slice(0, MAX_CONSUMED_IDS) : rawIds
  return {
    tokenIds: normalizeTokenIds(consumed),
    availableCount,
    asOfBlock,
    lagSeconds,
    stale,
    source: 'subgraph',
    truncated,
    warnings: [],
  }
}
