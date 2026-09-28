import type { Abi } from 'viem'

import { FACTORY_ABI } from '../abis/UniswapV2Factory'
import { PAIR_ABI } from '../abis/UniswapV2Pair'
import { WERC721_ABI } from '../abis/WERC721'
import { toAmount, toPoolAmount } from '../format'
import { wholeNfts } from '../liquidity/liquidityMath'
import type { Amount, TokenRef } from '../types/amount.types'
import type { SnfClientContext } from '../types/client.types'
import type { WnftBalances, WnftHolding, WnftSkip } from '../types/portfolio.types'
import { resolveLabels } from './labels'
import { nftPoolSet } from './poolSet'
import type { NftPoolEntry } from './poolSet.types'
import { normalizeAddress } from './shared'
import { readUsdPrices, toUsd } from './usd'

/**
 * `wnftBalances(owner)` — every fungible wNFT this owner holds for a collection with
 * an SnF pool on the client's chain, at ONE block. Discovery starts from the shared
 * `nftPoolSet`, grouped by distinct WRAPPER (a wrapper can back two pools — a native
 * one and an ERC-20-base one — and this method still issues exactly one
 * `balanceOf(owner)` for it).
 *
 * IDENTITY IS FACTORY-VERIFIED, NEVER SUBGRAPH-TRUSTED
 * A wrapper address the subgraph names is untrusted input: `Factory.getCollection
 * (wrapper)` is read on-chain and must equal the pool set's own collection for that
 * wrapper before any balance on it is reported as an SnF wNFT holding — otherwise
 * the wrapper is `skipped` as `WRAPPER_UNVERIFIED` rather than silently dropped, so a
 * caller can see exactly what was excluded and why. The same distrust applies to
 * `decimals()`: a genuine WERC721 is always 18-decimal; anything else is unverified.
 *
 * MID VALUE, NOT AN EXIT QUOTE
 * `valueInBase` marks the holding at the wrapper's native pool's current mid price —
 * `floor(balance * reserveBase / reserveWnft)` — not what an actual redemption would
 * pay out. An exit is `quoteSell` with this wNFT amount, which pays AMM slippage and
 * (in `nft` mode) floors to whole NFTs; those two numbers are expected to differ.
 *
 * THE NATIVE POOL ONLY
 * A wrapper has at most one native (chain-quote-token) pool, so pricing against it is
 * unambiguous. An ERC-20-base pool for the same wrapper would need that ERC-20's own
 * price, which this method's provider contract (native + optional per-token USD) does
 * not promise — `valueInBase` is `undefined` whenever no native pool prices the
 * wrapper, never a guess against a pool this method cannot value honestly.
 */

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

interface Call {
  readonly address: `0x${string}`
  readonly abi: Abi
  readonly functionName: string
  readonly args: readonly unknown[]
}
type CallResult = { readonly status: 'success' | 'failure'; readonly result?: unknown }

function isZeroAddress(addr: string): boolean {
  return addr.toLowerCase() === ZERO_ADDRESS
}

/** One distinct wrapper across every pool entry that references it — the first
 * entry's subgraph hint wins, but the native-pool candidate (if any entry in the
 * group has one) is always remembered regardless of registration order. */
interface WrapperGroup {
  readonly wrapper: `0x${string}`
  readonly collection: `0x${string}`
  readonly subgraphName: string | undefined
  readonly subgraphSymbol: string | undefined
  readonly nativeCandidatePair: `0x${string}` | undefined
}

function groupByWrapper(pools: readonly NftPoolEntry[], quoteToken: `0x${string}`): WrapperGroup[] {
  const byWrapper = new Map<string, WrapperGroup>()
  for (const entry of pools) {
    const key = entry.wrapper.toLowerCase()
    const isNativeEntry = entry.base.toLowerCase() === quoteToken.toLowerCase()
    const existing = byWrapper.get(key)
    if (existing === undefined) {
      byWrapper.set(key, {
        wrapper: entry.wrapper,
        collection: entry.collection,
        subgraphName: entry.subgraphName,
        subgraphSymbol: entry.subgraphSymbol,
        nativeCandidatePair: isNativeEntry ? entry.pair : undefined,
      })
    } else if (isNativeEntry && existing.nativeCandidatePair === undefined) {
      byWrapper.set(key, { ...existing, nativeCandidatePair: entry.pair })
    }
  }
  return Array.from(byWrapper.values())
}

interface HeldWrapper {
  readonly group: WrapperGroup
  readonly balance: bigint
  readonly verifiedCollection: `0x${string}`
}

function sortHoldings(a: WnftHolding, b: WnftHolding): number {
  if (a.balance.value !== b.balance.value) return a.balance.value > b.balance.value ? -1 : 1
  const left = a.wrapper.toLowerCase()
  const right = b.wrapper.toLowerCase()
  return left < right ? -1 : left > right ? 1 : 0
}

export async function wnftBalances(ctx: SnfClientContext, owner: `0x${string}`): Promise<WnftBalances> {
  const normalizedOwner = normalizeAddress(owner, 'owner')
  const poolSet = await nftPoolSet(ctx)
  const blockNumber = await ctx.publicClient.getBlockNumber()

  const empty = (skipped: readonly WnftSkip[] = []): WnftBalances => ({
    chainId: ctx.chain.chainId,
    owner: normalizedOwner,
    blockNumber,
    holdings: [],
    skipped,
    poolSet: poolSet.freshness,
  })

  const groups = groupByWrapper(poolSet.pools, ctx.chain.quoteToken)
  if (groups.length === 0) return empty()

  // ── Round 1 — every distinct wrapper's own balance + the Factory's reverse lookup,
  // one multicall: never one round trip per wrapper. ────────────────────────────
  const round1Contracts: Call[] = groups.flatMap((group) => [
    { address: group.wrapper, abi: WERC721_ABI, functionName: 'balanceOf', args: [normalizedOwner] },
    { address: ctx.chain.factory, abi: FACTORY_ABI, functionName: 'getCollection', args: [group.wrapper] },
  ])
  const round1: readonly CallResult[] = await ctx.publicClient.multicall({
    contracts: round1Contracts,
    allowFailure: true,
    multicallAddress: ctx.chain.multicall3,
    batchSize: 0,
    blockNumber,
  })

  const skipped: WnftSkip[] = []
  const held: HeldWrapper[] = []
  groups.forEach((group, i) => {
    const balanceResult = round1[i * 2]
    if (balanceResult?.status !== 'success') {
      skipped.push({ wrapper: group.wrapper, code: 'NO_ROUTE' })
      return
    }
    const balance = balanceResult.result as bigint
    if (balance === 0n) return // omitted, not read further — never a skip entry

    const collectionResult = round1[i * 2 + 1]
    const onChainCollection =
      collectionResult?.status === 'success' ? (collectionResult.result as `0x${string}`) : ZERO_ADDRESS
    if (isZeroAddress(onChainCollection) || onChainCollection.toLowerCase() !== group.collection.toLowerCase()) {
      skipped.push({ wrapper: group.wrapper, code: 'WRAPPER_UNVERIFIED' })
      return
    }
    held.push({ group, balance, verifiedCollection: onChainCollection })
  })

  if (held.length === 0) return empty(skipped)

  // ── Round 2 (held wrappers only) — decimals identity + the Factory's own native
  // pair, plus (when the pool set already names a native-pool candidate) that
  // pair's own reserves/orientation, so the value step never trusts the candidate
  // without a matching Factory answer. ──────────────────────────────────────────
  const round2Contracts: Call[] = []
  const round2Index = new Map<string, number>()
  for (const h of held) {
    round2Index.set(h.group.wrapper.toLowerCase(), round2Contracts.length)
    round2Contracts.push(
      { address: h.group.wrapper, abi: WERC721_ABI, functionName: 'decimals', args: [] },
      { address: ctx.chain.factory, abi: FACTORY_ABI, functionName: 'getPair', args: [h.group.wrapper, ctx.chain.quoteToken] },
    )
    if (h.group.nativeCandidatePair !== undefined) {
      round2Contracts.push(
        { address: h.group.nativeCandidatePair, abi: PAIR_ABI, functionName: 'getReserves', args: [] },
        { address: h.group.nativeCandidatePair, abi: PAIR_ABI, functionName: 'token0', args: [] },
      )
    }
  }
  const round2: readonly CallResult[] = await ctx.publicClient.multicall({
    contracts: round2Contracts,
    allowFailure: true,
    multicallAddress: ctx.chain.multicall3,
    batchSize: 0,
    blockNumber,
  })

  const nativeBaseUnit = { symbol: ctx.chain.nativeSymbol, decimals: ctx.chain.quoteDecimals }
  const verified: Array<{ readonly h: HeldWrapper; readonly valueInBase: Amount | undefined }> = []

  for (const h of held) {
    const base = round2Index.get(h.group.wrapper.toLowerCase())!
    const decimalsResult = round2[base]
    const decimals = decimalsResult?.status === 'success' ? (decimalsResult.result as number) : undefined
    if (decimals !== 18) {
      skipped.push({ wrapper: h.group.wrapper, code: 'WRAPPER_UNVERIFIED' })
      continue
    }

    const getPairResult = round2[base + 1]
    const factoryNativePair =
      getPairResult?.status === 'success' ? (getPairResult.result as `0x${string}`) : undefined

    let valueInBase: Amount | undefined
    if (
      h.group.nativeCandidatePair !== undefined &&
      factoryNativePair !== undefined &&
      !isZeroAddress(factoryNativePair) &&
      factoryNativePair.toLowerCase() === h.group.nativeCandidatePair.toLowerCase()
    ) {
      const reservesResult = round2[base + 2]
      const token0Result = round2[base + 3]
      if (reservesResult?.status === 'success' && token0Result?.status === 'success') {
        const [reserve0, reserve1] = reservesResult.result as readonly [bigint, bigint, number]
        const token0 = token0Result.result as `0x${string}`
        const wrapperIsToken0 = token0.toLowerCase() === h.group.wrapper.toLowerCase()
        const reserveWnft = wrapperIsToken0 ? reserve0 : reserve1
        const reserveBase = wrapperIsToken0 ? reserve1 : reserve0
        if (reserveWnft > 0n) valueInBase = toPoolAmount(nativeBaseUnit, (h.balance * reserveBase) / reserveWnft)
      }
    }
    verified.push({ h, valueInBase })
  }

  if (verified.length === 0) return empty(skipped)

  const labels = await resolveLabels(
    ctx,
    verified.map(({ h }) => ({
      collection: h.verifiedCollection,
      subgraphName: h.group.subgraphName,
      subgraphSymbol: h.group.subgraphSymbol,
    })),
    blockNumber,
  )
  const nativeToken: TokenRef = { address: ctx.chain.quoteToken, symbol: ctx.chain.nativeSymbol, decimals: ctx.chain.quoteDecimals, isNative: true }
  const usdPrices = await readUsdPrices(ctx, [nativeToken])
  const priceKey = ctx.chain.quoteToken.toLowerCase()

  const holdings: WnftHolding[] = verified.map(({ h, valueInBase }) => ({
    collection: h.verifiedCollection,
    wrapper: h.group.wrapper,
    labels: labels.get(h.verifiedCollection.toLowerCase())!,
    balance: toAmount(h.balance, 18, 'wNFT'),
    nftWhole: wholeNfts(h.balance),
    valueInBase,
    valuation: 'mid',
    valueUsd: valueInBase !== undefined ? toUsd(valueInBase, usdPrices.get(priceKey)) : undefined,
  }))

  return {
    chainId: ctx.chain.chainId,
    owner: normalizedOwner,
    blockNumber,
    holdings: holdings.sort(sortHoldings),
    skipped,
    poolSet: poolSet.freshness,
  }
}
