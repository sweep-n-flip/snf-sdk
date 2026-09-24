import { ROUTER02_COLLECTION_ABI } from '../abis/UniswapV2Router02Collection'
import { ROUTER_NATIVE_ERC20_ABI } from '../abis/UniswapV2Router01CollectionNativeERC20'
import { resolveCollection } from '../collection/resolveCollection'
import { assertChainMatch, assertParam, SnfError } from '../errors'
import { bpsFromRatio, toPoolAmount } from '../format'
import { normalizeTokenIds } from '../inventory/availability'
import { getAmountOut, ONE_E18 } from '../math/quoteMath'
import { reconcileNet } from '../math/reconcile'
import { buildNftRoutePath, buildWnftRoutePath } from '../routing/nftRoutePaths'
import { filterViablePayTokens } from '../routing/directOnlyRouting'
import { wnftUnitsFromCount } from '../routing/wnftPathScale'
import { loadQuoteContext } from './quoteContext'
import type { CollectionInfo, PoolRef } from '../types/collection.types'
import type { SnfClientContext } from '../types/client.types'
import type { FeeBreakdown, Quote, QuoteLeg, QuoteSellArgs } from '../types/quote.types'

/**
 * On-chain proceeds from selling `tokenIds`/`count` NFTs of a collection,
 * reconciled to the wei against the Router's own `getAmountsOutCollection`.
 *
 * THE ASYMMETRIC FOOTGUN: `getAmountsInCollection` (buy) returns GROSS — fee and
 * royalty still to be added. `getAmountsOutCollection` (sell) returns NET — fee and
 * royalty ALREADY deducted. The names are asymmetric on purpose, and this is the
 * codebase's #1 pricing footgun (a known pricing pitfall: "a sell quote's displayed
 * total is suspiciously ~5-7% lower than the pool-only price" is the symptom of
 * re-subtracting a second time). See the assignment below.
 */

const MAX_IDS = 50
const QUOTE_TTL_MS = 30_000

function isZeroAddress(address: `0x${string}`): boolean {
  return /^0x0+$/i.test(address)
}

function validateArgs(args: QuoteSellArgs): void {
  const modes = [args.tokenIds !== undefined, args.count !== undefined, args.amount !== undefined].filter(
    Boolean,
  ).length
  assertParam(modes === 1, 'quoteSell requires exactly one of tokenIds, count or amount', {
    field: 'tokenIds|count|amount',
  })
  assertParam(
    args.count === undefined,
    'quoteSell requires tokenIds — a count-only sell has no owner address to resolve holdings from',
    { field: 'count' },
  )
  if (args.tokenIds !== undefined) {
    assertParam(
      args.tokenIds.length >= 1 && args.tokenIds.length <= MAX_IDS,
      'tokenIds must have between 1 and 50 entries',
      { field: 'tokenIds', value: args.tokenIds.length },
    )
  }
  if (args.amount !== undefined) {
    assertParam(args.amount > 0n, 'amount must be a positive bigint (wrapper units)', { field: 'amount' })
  }
  assertParam(/^0x[0-9a-fA-F]{40}$/.test(args.collection), 'collection must be a well-formed 0x address', {
    field: 'collection',
  })
}

function pickPool(pools: readonly PoolRef[], receiveToken: `0x${string}` | null | undefined): PoolRef | undefined {
  if (receiveToken === undefined || receiveToken === null) return pools.find((p) => p.isNative)
  const lower = receiveToken.toLowerCase()
  return pools.find((p) => p.baseToken.address?.toLowerCase() === lower)
}

function sellPriceImpact(reserves: { readonly base: bigint; readonly wnft: bigint }, actual: bigint, units: bigint): number {
  if (units <= 0n || reserves.wnft <= 0n) return 0
  const nominal = (reserves.base * units) / reserves.wnft
  if (nominal <= 0n || actual >= nominal) return 0
  return Math.min(100, bpsFromRatio(nominal - actual, nominal) / 100)
}

/** The fractional wNFT branch — mirrors `quoteBuy`'s fungible leg: no marketplace
 * fee, no royalty (those only apply through the `*Collection` entry points), pure
 * AMM curve via the plain `getAmountsOut`. */
async function quoteSellFungible(
  ctx: SnfClientContext,
  args: QuoteSellArgs,
  collection: CollectionInfo,
  pool: PoolRef,
): Promise<Quote> {
  const amount = args.amount as bigint
  const routerAbi = ctx.chain.routerVariant === 'native-erc20' ? ROUTER_NATIVE_ERC20_ABI : ROUTER02_COLLECTION_ABI
  const base = pool.baseToken.address ?? ctx.chain.quoteToken
  const path = buildWnftRoutePath({ wrapper: collection.wrapper, baseToken: base, side: 'sell' })

  const results = await ctx.publicClient.multicall({
    contracts: [{ address: ctx.chain.router02, abi: routerAbi, functionName: 'getAmountsOut', args: [amount, path] }],
    allowFailure: true,
    multicallAddress: ctx.chain.multicall3,
    batchSize: 0,
  })
  const result = results[0]
  if (result?.status !== 'success') {
    throw new SnfError('NO_ROUTE', 'Could not read getAmountsOut for the wNFT fungible leg', {
      details: { pair: pool.pair },
    })
  }
  const amounts = result.result
  const routerProceeds = amounts[amounts.length - 1]
  if (routerProceeds === undefined) {
    throw new SnfError('NO_ROUTE', 'getAmountsOut returned an empty amounts[] array', {
      details: { pair: pool.pair },
    })
  }

  const localProceeds = getAmountOut(amount, pool.reserves.wnft, pool.reserves.base, BigInt(ctx.chain.poolNetFee))
  if (localProceeds === undefined) {
    throw new SnfError('NO_ROUTE', 'This pool cannot fill the requested wNFT amount', { details: { pair: pool.pair } })
  }
  reconcileNet({ pool: localProceeds, marketplace: 0n, royalty: 0n, routerNet: routerProceeds })

  const chainId = ctx.chain.chainId
  const poolBps = 10_000 - ctx.chain.poolNetFee
  const fees: FeeBreakdown = {
    pool: { bps: poolBps, note: 'included in curve' },
    marketplace: { ...toPoolAmount(pool.baseToken, 0n), bps: 0 },
    royalty: { ...toPoolAmount(pool.baseToken, 0n), bps: 0, capApplied: false },
  }
  const leg: QuoteLeg = {
    pair: pool.pair,
    count: 0,
    amount: toPoolAmount(pool.baseToken, routerProceeds),
    path,
    feeBps: poolBps,
    kind: 'wnft',
    side: 'sell',
    collection: collection.address,
    wrapper: collection.wrapper,
  }

  return {
    side: 'sell',
    chainId,
    collection: collection.address,
    legs: [leg],
    fees,
    totalProceeds: toPoolAmount(pool.baseToken, routerProceeds),
    priceImpact: sellPriceImpact(pool.reserves, routerProceeds, amount),
    deliverable: 0,
    bestEffort: false,
    expiresAt: new Date(Date.now() + QUOTE_TTL_MS).toISOString(),
    reconciled: true,
  }
}

export async function quoteSell(ctx: SnfClientContext, args: QuoteSellArgs): Promise<Quote> {
  assertChainMatch(args.chainId, ctx.chain.chainId)
  validateArgs(args)

  const collection = await resolveCollection(ctx, args.collection)
  if (collection.pools.length === 0) {
    throw new SnfError('NO_ROUTE', 'No pool exists for this collection', {
      details: { collection: args.collection, viablePayTokens: [] },
    })
  }

  const pool = pickPool(collection.pools, args.receiveToken)
  if (!pool) {
    throw new SnfError('NO_ROUTE', 'No pool for the requested receiveToken', {
      details: { viablePayTokens: filterViablePayTokens({ candidates: collection.pools }) },
    })
  }

  if (args.amount !== undefined) {
    return quoteSellFungible(ctx, args, collection, pool)
  }

  const tokenIds = normalizeTokenIds(args.tokenIds as readonly string[])
  const deliverable = tokenIds.length

  const ctxData = await loadQuoteContext(ctx, {
    pair: pool.pair,
    wrapper: collection.wrapper,
    collection: collection.address,
    baseToken: pool.baseToken,
    tokenIds,
    side: 'sell',
  })

  const isArc = ctx.chain.routerVariant === 'native-erc20'
  const royaltyRaw = ctxData.perIdRoyalty.reduce((sum, line) => sum + line.amount, 0n)
  const unpayable = ctxData.perIdRoyalty.reduce(
    (sum, line) => sum + (isZeroAddress(line.receiver) ? line.amount : 0n),
    0n,
  )
  // Arc's Router variant returns an unpayable (zero-address) EIP-2981 receiver's
  // share TO THE SELLER — the Router's own net proceeds already reflect this, so
  // the adjustment happens BEFORE reconciliation, never after.
  const royaltyCharged = isArc ? royaltyRaw - unpayable : royaltyRaw
  const marketplace = (ctxData.poolLeg * ctxData.marketplaceFeeE18) / ONE_E18

  reconcileNet({
    pool: ctxData.poolLeg,
    marketplace,
    royalty: royaltyCharged,
    routerNet: ctxData.routerTotal,
  })

  const chainId = ctx.chain.chainId
  const poolBps = 10_000 - ctx.chain.poolNetFee
  const marketplaceBps = marketplace > 0n ? bpsFromRatio(marketplace, ctxData.poolLeg) : 0
  const royaltyBps = royaltyCharged > 0n ? bpsFromRatio(royaltyCharged, ctxData.poolLeg) : 0

  const fees: FeeBreakdown = {
    pool: { bps: poolBps, note: 'included in curve' },
    marketplace: { ...toPoolAmount(pool.baseToken, marketplace), bps: marketplaceBps },
    royalty: { ...toPoolAmount(pool.baseToken, royaltyCharged), bps: royaltyBps, capApplied: false },
  }

  const baseAddress = pool.baseToken.address ?? ctx.chain.quoteToken
  const path = buildNftRoutePath({ collection: collection.address, baseToken: baseAddress, side: 'sell' })
  const leg: QuoteLeg = {
    pair: pool.pair,
    count: deliverable,
    // The Router's getAmountsOutCollection result is already NET (fee and
    // royalty deducted on-chain) — assigned straight through, no further
    // subtraction (see the capitalized warning on `totalProceeds` below).
    amount: toPoolAmount(pool.baseToken, ctxData.routerTotal),
    path,
    feeBps: poolBps,
    kind: pool.baseToken.isNative ? 'native' : 'erc20',
    side: 'sell',
    collection: collection.address,
    wrapper: collection.wrapper,
    tokenIds,
  }

  const warnings: string[] = []
  if (collection.redemptionLocked) {
    warnings.push(
      'This collection currently blocks NFT redemption from the wrapper — a buyer of these NFTs may be unable to unwrap them; consider the wNFT sell path instead.',
    )
  }
  if (isArc && unpayable > 0n) {
    warnings.push(
      "This collection's EIP-2981 receiver is the zero address for one or more items — the Router returns that share to the seller (Arc _unpayableRoyalties).",
    )
  }

  return {
    side: 'sell',
    chainId,
    collection: collection.address,
    count: deliverable,
    tokenIds,
    legs: [leg],
    fees,
    // NEVER SUBTRACT AGAIN — see the leg's `amount` comment above; this is the
    // same Router-net value, never re-derived.
    totalProceeds: toPoolAmount(pool.baseToken, ctxData.routerTotal),
    priceImpact: sellPriceImpact(ctxData.reserves, ctxData.poolLeg, wnftUnitsFromCount(deliverable)),
    deliverable,
    bestEffort: false,
    expiresAt: new Date(Date.now() + QUOTE_TTL_MS).toISOString(),
    reconciled: true,
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}
