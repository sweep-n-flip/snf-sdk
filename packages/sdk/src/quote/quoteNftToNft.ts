import { resolveCollection } from '../collection/resolveCollection'
import { assertChainMatch, SnfError, assertParam } from '../errors'
import { bpsFromRatio, toAmount, toQuoteAmount } from '../format'
import { availableCountFromReserve, normalizeTokenIds } from '../inventory/availability'
import { poolInventory } from '../inventory/poolInventory'
import { getAmountOut, ONE_E18 } from '../math/quoteMath'
import { reconcileGross, reconcileNet } from '../math/reconcile'
import { buildNftRoutePath } from '../routing/nftRoutePaths'
import { evaluateRouteBlock } from '../routing/routeBlock'
import { wnftUnitsFromCount } from '../routing/wnftPathScale'
import { crossPoolPriceImpact, spotNominal } from './priceImpact'
import { loadQuoteContext } from './quoteContext'
import type { CollectionInfo, PoolRef } from '../types/collection.types'
import type { PoolRef as RoutingPoolRef } from '../routing/routing.types'
import type { SnfClientContext } from '../types/client.types'
import type { Amount } from '../types/amount.types'
import type { FeeBreakdown, Quote, QuoteLeg, QuoteNftToNftArgs } from '../types/quote.types'

/**
 * Two-leg collection→collection quote: sell `sell.tokenIds` of collection A, buy
 * `buy.count` of collection B. `legs[0]` is ALWAYS the sell, `legs[1]` ALWAYS the buy —
 * both `NFT×NFT branches go FIRST` (docs/NFT_SWAP_RULES.md) in the sense that this
 * module never re-derives its math from the single-leg `quoteBuy`/`quoteSell` branches;
 * it reuses their shared primitive, `loadQuoteContext`, once per leg.
 *
 * RSS IS PAID PER LEG, NEVER CONSOLIDATED — royalty stays inside each leg's own
 * `fees.royalty`, in that leg's own base currency; `Quote.fees.royalty` is only the
 * SUM for display (valid because a same-base pair is required below — a consolidated
 * currency conversion never happens). Consolidating would require extra swaps, eat
 * fees, violate EIP-2981's "royalty paid in the sale currency" semantics, and reduce
 * what the creator actually receives — two collections sharing a creator wallet
 * legitimately produce two separate amounts; that is fidelity to two isolated sales,
 * not a bug (docs/NFT_SWAP_RULES.md).
 *
 * `remainder` SATURATES AT 0n — `netProceeds` (leg 1) and `buyCost` (leg 2) are both
 * exposed so a caller can always derive the top-up as `buyCost − netProceeds` when the
 * buy costs more than the sell nets. There is no separate `shortfall` field, by design
 * (DATASHEET §4 "Remainder field").
 */

const MAX_IDS = 50
const QUOTE_TTL_MS = 30_000

function isZeroAddress(address: `0x${string}`): boolean {
  return /^0x0+$/i.test(address)
}

function validateArgs(args: QuoteNftToNftArgs): void {
  assertParam(/^0x[0-9a-fA-F]{40}$/.test(args.sell.collection), 'sell.collection must be a well-formed 0x address', {
    field: 'sell.collection',
  })
  assertParam(/^0x[0-9a-fA-F]{40}$/.test(args.buy.collection), 'buy.collection must be a well-formed 0x address', {
    field: 'buy.collection',
  })
  assertParam(
    args.sell.collection.toLowerCase() !== args.buy.collection.toLowerCase(),
    'sell.collection and buy.collection must be different collections',
    { field: 'sell.collection|buy.collection' },
  )
  assertParam(
    args.sell.tokenIds.length >= 1 && args.sell.tokenIds.length <= MAX_IDS,
    'sell.tokenIds must have between 1 and 50 entries',
    { field: 'sell.tokenIds', value: args.sell.tokenIds.length },
  )
  assertParam(
    Number.isInteger(args.buy.count) && args.buy.count >= 1 && args.buy.count <= MAX_IDS,
    'buy.count must be an integer between 1 and 50',
    { field: 'buy.count', value: args.buy.count },
  )
  assertParam(args.remainder === 'native' || args.remainder === 'wnft', "remainder must be 'native' or 'wnft'", {
    field: 'remainder',
  })
}

/** Native-base pool preferred; falls back to the first pool when no native-base pool
 * exists (matches `quoteBuy`/`quoteSell`'s own default-pool convention). */
function pickPool(pools: readonly PoolRef[]): PoolRef | undefined {
  return pools.find((p) => p.isNative) ?? pools[0]
}

/** `evaluateRouteBlock`'s `candidates` uses a stricter `PoolRef` (routing.types.ts,
 * carrying `token0`/`token1`) than `resolveCollection`'s own `PoolRef` (collection.
 * types.ts) — reconstructs `token0`/`token1` from `wrapperIsToken0` (never assumed by
 * index, CLAUDE.md) rather than passing placeholders. */
function toRoutingPoolRef(pool: PoolRef, wrapper: `0x${string}`): RoutingPoolRef {
  const base = pool.baseToken.address ?? '0x0000000000000000000000000000000000000000'
  return {
    pair: pool.pair,
    token0: pool.wrapperIsToken0 ? wrapper : base,
    token1: pool.wrapperIsToken0 ? base : wrapper,
    baseToken: pool.baseToken,
  }
}

function royaltyCharged(
  ctxData: { readonly perIdRoyalty: readonly { readonly receiver: `0x${string}`; readonly amount: bigint }[] },
  isArc: boolean,
): bigint {
  const raw = ctxData.perIdRoyalty.reduce((sum, line) => sum + line.amount, 0n)
  if (!isArc) return raw
  const unpayable = ctxData.perIdRoyalty.reduce(
    (sum, line) => sum + (isZeroAddress(line.receiver) ? line.amount : 0n),
    0n,
  )
  // Arc's Router variant drops an unpayable (zero-address) EIP-2981 receiver's share —
  // never charged to the buyer, never deducted from the seller (mirrors quoteBuy/
  // quoteSell's identical adjustment).
  return raw - unpayable
}

function legFees(chainId: number, poolBps: number, marketplace: bigint, royalty: bigint, poolLeg: bigint): FeeBreakdown {
  return {
    pool: { bps: poolBps, note: 'included in curve' },
    marketplace: { ...toQuoteAmount(chainId, marketplace), bps: marketplace > 0n ? bpsFromRatio(marketplace, poolLeg) : 0 },
    royalty: { ...toQuoteAmount(chainId, royalty), bps: royalty > 0n ? bpsFromRatio(royalty, poolLeg) : 0, capApplied: false },
  }
}

async function resolveBuyLeg(
  ctx: SnfClientContext,
  buyCollection: CollectionInfo,
  buyPool: PoolRef,
  requestedCount: number,
): Promise<{ readonly tokenIds: readonly string[]; readonly deliverable: number; readonly bestEffort: boolean }> {
  const availableCount = availableCountFromReserve(buyPool.reserves.wnft)
  if (availableCount === 0) {
    throw new SnfError('NO_ROUTE', 'The buy pool currently has nothing available to buy', {
      details: { pair: buyPool.pair },
    })
  }
  const inventory = await poolInventory(ctx, buyPool.pair)
  const deliverable = Math.min(requestedCount, availableCount, inventory.tokenIds.length)
  if (deliverable === 0) {
    throw new SnfError('NO_ROUTE', 'No tokenIds could be resolved for the buy leg', {
      details: { collection: buyCollection.address },
    })
  }
  return { tokenIds: inventory.tokenIds.slice(0, deliverable), deliverable, bestEffort: deliverable < requestedCount }
}

export async function quoteNftToNft(ctx: SnfClientContext, args: QuoteNftToNftArgs): Promise<Quote> {
  assertChainMatch(args.chainId, ctx.chain.chainId)
  validateArgs(args)

  const [sellCollection, buyCollection] = await Promise.all([
    resolveCollection(ctx, args.sell.collection),
    resolveCollection(ctx, args.buy.collection),
  ])

  const sellPool = pickPool(sellCollection.pools)
  if (!sellPool) {
    throw new SnfError('NO_ROUTE', 'No pool exists for the sell collection', {
      details: { collection: args.sell.collection, viablePayTokens: [] },
    })
  }
  const buyPool = pickPool(buyCollection.pools)
  if (!buyPool) {
    throw new SnfError('NO_ROUTE', 'No pool exists for the buy collection', {
      details: { collection: args.buy.collection, viablePayTokens: [] },
    })
  }

  // Cross-base NFT×NFT is not expressible on-chain — the atomic Router path is
  // single-hop + same-base only (DATASHEET §4). A partner can still execute this as
  // two separate user-driven swaps; this SDK never attempts to compose it.
  const routeCheck = evaluateRouteBlock({
    candidates: [toRoutingPoolRef(sellPool, sellCollection.wrapper), toRoutingPoolRef(buyPool, buyCollection.wrapper)],
    path: undefined,
    directOnlyBaseAddresses: [],
    nftToNft: { sellPoolBase: sellPool.baseToken, buyPoolBase: buyPool.baseToken },
  })
  if (routeCheck.blocked) {
    throw new SnfError(
      'NO_ROUTE',
      'The sell and buy pools price in different base currencies — the Router cannot compose two legs across different bases. Execute this as two separate swaps instead.',
      { details: { reason: routeCheck.reason, viablePayTokens: routeCheck.viablePayTokens } },
    )
  }

  const isArc = ctx.chain.routerVariant === 'native-erc20'
  const chainId = ctx.chain.chainId
  const poolBps = 10_000 - ctx.chain.poolNetFee

  // ── Leg 1 — the sell ──────────────────────────────────────────────────────────
  const sellTokenIds = normalizeTokenIds(args.sell.tokenIds)
  const sellCtx = await loadQuoteContext(ctx, {
    pair: sellPool.pair,
    wrapper: sellCollection.wrapper,
    collection: sellCollection.address,
    baseToken: sellPool.baseToken,
    tokenIds: sellTokenIds,
    side: 'sell',
  })
  const sellRoyalty = royaltyCharged(sellCtx, isArc)
  const sellMarketplace = (sellCtx.poolLeg * sellCtx.marketplaceFeeE18) / ONE_E18
  reconcileNet({ pool: sellCtx.poolLeg, marketplace: sellMarketplace, royalty: sellRoyalty, routerNet: sellCtx.routerTotal })
  const netProceedsValue = sellCtx.routerTotal

  // ── Leg 2 — the buy ───────────────────────────────────────────────────────────
  const { tokenIds: buyTokenIds, deliverable, bestEffort } = await resolveBuyLeg(ctx, buyCollection, buyPool, args.buy.count)
  const buyCtx = await loadQuoteContext(ctx, {
    pair: buyPool.pair,
    wrapper: buyCollection.wrapper,
    collection: buyCollection.address,
    baseToken: buyPool.baseToken,
    tokenIds: buyTokenIds,
    side: 'buy',
  })
  const buyRoyalty = royaltyCharged(buyCtx, isArc)
  const buyMarketplace = (buyCtx.poolLeg * buyCtx.marketplaceFeeE18) / ONE_E18
  reconcileGross({ pool: buyCtx.poolLeg, marketplace: buyMarketplace, royalty: buyRoyalty, routerGross: buyCtx.routerTotal })
  const buyCostValue = buyCtx.routerTotal

  // ── Remainder — saturates at 0n; the top-up is `buyCostValue − netProceedsValue`
  // whenever `buyCostValue > netProceedsValue` (never a negative or wrapped value).
  const remainderBaseValue = netProceedsValue > buyCostValue ? netProceedsValue - buyCostValue : 0n

  let remainderAmount: Amount
  let remainderWnftUnits = 0n
  if (args.remainder === 'wnft') {
    if (remainderBaseValue > 0n) {
      // The wNFT top-up is a REAL sequential on-chain trade AFTER the buy leg has
      // already consumed buyCtx.poolLeg/deliverable from the pool — priced against
      // the post-buy reserves, never the pre-buy snapshot.
      const postBuyBase = buyCtx.reserves.base + buyCtx.poolLeg
      const postBuyWnft = buyCtx.reserves.wnft - wnftUnitsFromCount(deliverable)
      remainderWnftUnits = getAmountOut(remainderBaseValue, postBuyBase, postBuyWnft, BigInt(ctx.chain.poolNetFee)) ?? 0n
    }
    remainderAmount = toAmount(remainderWnftUnits, 18, buyCollection.labels.symbol)
  } else {
    remainderAmount = toQuoteAmount(chainId, remainderBaseValue)
  }

  // ── priceImpact — spot-vs-actual across both pools (Task 1), never a curve quote.
  const feePolicy = {
    marketplaceFeeE18: sellCtx.marketplaceFeeE18,
    royaltyOn: sellRoyalty > 0n || buyRoyalty > 0n,
    sellRoyaltyE18: sellCtx.poolLeg > 0n ? (sellRoyalty * ONE_E18) / sellCtx.poolLeg : 0n,
    buyRoyaltyE18: buyCtx.poolLeg > 0n ? (buyRoyalty * ONE_E18) / buyCtx.poolLeg : 0n,
  }
  const nominal = spotNominal({
    sellReserves: sellCtx.reserves,
    buyReserves: buyCtx.reserves,
    sellCount: BigInt(sellTokenIds.length),
    feePolicy,
  })
  const actualReceiveUnits = wnftUnitsFromCount(deliverable) + remainderWnftUnits
  const priceImpact = crossPoolPriceImpact({ nominalReceive: nominal.nominalReceive, actualReceive: actualReceiveUnits })

  // ── Assemble the two legs — legs[0] is always the sell, legs[1] always the buy.
  const sellBaseAddress = sellPool.baseToken.address ?? ctx.chain.quoteToken
  const buyBaseAddress = buyPool.baseToken.address ?? ctx.chain.quoteToken
  const sellLeg: QuoteLeg = {
    pair: sellPool.pair,
    count: sellTokenIds.length,
    amount: toQuoteAmount(chainId, netProceedsValue),
    path: buildNftRoutePath({ collection: sellCollection.address, baseToken: sellBaseAddress, side: 'sell' }),
    feeBps: poolBps,
    kind: sellPool.baseToken.isNative ? 'native' : 'erc20',
    side: 'sell',
    fees: legFees(chainId, poolBps, sellMarketplace, sellRoyalty, sellCtx.poolLeg),
    collection: sellCollection.address,
    wrapper: sellCollection.wrapper,
    tokenIds: sellTokenIds,
  }
  const buyLeg: QuoteLeg = {
    pair: buyPool.pair,
    count: deliverable,
    amount: toQuoteAmount(chainId, buyCostValue),
    path: buildNftRoutePath({ collection: buyCollection.address, baseToken: buyBaseAddress, side: 'buy' }),
    feeBps: poolBps,
    kind: buyPool.baseToken.isNative ? 'native' : 'erc20',
    side: 'buy',
    fees: legFees(chainId, poolBps, buyMarketplace, buyRoyalty, buyCtx.poolLeg),
    collection: buyCollection.address,
    wrapper: buyCollection.wrapper,
    tokenIds: buyTokenIds,
  }

  const totalMarketplace = sellMarketplace + buyMarketplace
  const totalRoyalty = sellRoyalty + buyRoyalty
  const totalPoolLeg = sellCtx.poolLeg + buyCtx.poolLeg
  const fees: FeeBreakdown = {
    pool: { bps: poolBps, note: 'included in curve (both legs)' },
    marketplace: {
      ...toQuoteAmount(chainId, totalMarketplace),
      bps: totalMarketplace > 0n ? bpsFromRatio(totalMarketplace, totalPoolLeg) : 0,
    },
    royalty: {
      ...toQuoteAmount(chainId, totalRoyalty),
      bps: totalRoyalty > 0n ? bpsFromRatio(totalRoyalty, totalPoolLeg) : 0,
      capApplied: false,
    },
  }

  const warnings: string[] = []
  if (sellRoyalty > 0n || buyRoyalty > 0n) {
    const sellBps = sellRoyalty > 0n ? bpsFromRatio(sellRoyalty, sellCtx.poolLeg) : 0
    const buyBps = buyRoyalty > 0n ? bpsFromRatio(buyRoyalty, buyCtx.poolLeg) : 0
    warnings.push(
      `Royalty is charged per leg in that leg's own base currency, never consolidated: ${sellBps} bps on the sell (${sellCollection.labels.symbol}), ${buyBps} bps on the buy (${buyCollection.labels.symbol}).`,
    )
  }
  if (sellCollection.redemptionLocked) {
    warnings.push('The sell collection currently blocks NFT redemption from the wrapper.')
  }

  return {
    side: 'nft-to-nft',
    chainId,
    legs: [sellLeg, buyLeg],
    fees,
    netProceeds: toQuoteAmount(chainId, netProceedsValue),
    buyCost: toQuoteAmount(chainId, buyCostValue),
    remainder: remainderAmount,
    remainderMode: args.remainder,
    priceImpact,
    deliverable,
    bestEffort,
    expiresAt: new Date(Date.now() + QUOTE_TTL_MS).toISOString(),
    reconciled: true,
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}
