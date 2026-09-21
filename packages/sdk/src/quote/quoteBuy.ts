import { ROUTER02_COLLECTION_ABI } from '../abis/UniswapV2Router02Collection'
import { ROUTER_NATIVE_ERC20_ABI } from '../abis/UniswapV2Router01CollectionNativeERC20'
import { resolveCollection } from '../collection/resolveCollection'
import { assertParam, SnfError } from '../errors'
import { bpsFromRatio, toQuoteAmount } from '../format'
import { availableCountFromReserve, normalizeTokenIds } from '../inventory/availability'
import { poolInventory } from '../inventory/poolInventory'
import { getAmountIn, ONE_E18 } from '../math/quoteMath'
import { reconcileGross } from '../math/reconcile'
import { buildNftRoutePath, buildWnftRoutePath } from '../routing/nftRoutePaths'
import { filterViablePayTokens } from '../routing/directOnlyRouting'
import { wnftUnitsFromCount } from '../routing/wnftPathScale'
import { loadQuoteContext } from './quoteContext'
import type { CollectionInfo, PoolRef } from '../types/collection.types'
import type { SnfClientContext } from '../types/client.types'
import type { FeeBreakdown, Quote, QuoteBuyArgs, QuoteLeg } from '../types/quote.types'

/**
 * On-chain cost to buy `count`/`tokenIds` NFTs of a collection, reconciled to the
 * wei against the Router's own `getAmountsInCollection` (R8). Never absorbs a
 * divergence silently — a 1-wei mismatch throws `SnfError('QUOTE_RECONCILIATION_
 * FAILED')` and no `Quote` is returned.
 *
 * The Router's number is authoritative and this file's reconstruction is the
 * audit. They must be equal. If they are not, something about this collection or
 * this chain is not what the SDK believes, and shipping a plausible-looking number
 * would be worse than failing.
 */

const MAX_IDS = 50
const QUOTE_TTL_MS = 30_000

function isZeroAddress(address: `0x${string}`): boolean {
  return /^0x0+$/i.test(address)
}

function validateArgs(args: QuoteBuyArgs): void {
  const modes = [args.tokenIds !== undefined, args.count !== undefined, args.amount !== undefined].filter(
    Boolean,
  ).length
  assertParam(modes === 1, 'quoteBuy requires exactly one of tokenIds, count or amount', {
    field: 'tokenIds|count|amount',
  })
  if (args.tokenIds !== undefined) {
    assertParam(
      args.tokenIds.length >= 1 && args.tokenIds.length <= MAX_IDS,
      'tokenIds must have between 1 and 50 entries',
      { field: 'tokenIds', value: args.tokenIds.length },
    )
  }
  if (args.count !== undefined) {
    assertParam(
      Number.isInteger(args.count) && args.count >= 1 && args.count <= MAX_IDS,
      'count must be an integer between 1 and 50',
      { field: 'count', value: args.count },
    )
  }
  if (args.amount !== undefined) {
    assertParam(args.amount > 0n, 'amount must be a positive bigint (wrapper units)', { field: 'amount' })
  }
  assertParam(/^0x[0-9a-fA-F]{40}$/.test(args.collection), 'collection must be a well-formed 0x address', {
    field: 'collection',
  })
}

function pickPool(pools: readonly PoolRef[], payToken: `0x${string}` | null | undefined): PoolRef | undefined {
  if (payToken === undefined || payToken === null) return pools.find((p) => p.isNative)
  const lower = payToken.toLowerCase()
  return pools.find((p) => p.baseToken.address?.toLowerCase() === lower)
}

function buyPriceImpact(reserves: { readonly base: bigint; readonly wnft: bigint }, actual: bigint, units: bigint): number {
  if (units <= 0n || reserves.wnft <= 0n) return 0
  const nominal = (reserves.base * units) / reserves.wnft
  if (nominal <= 0n || actual <= nominal) return 0
  return Math.min(100, bpsFromRatio(actual - nominal, nominal) / 100)
}

/** The fractional wNFT branch — `args.amount` routes through the fungible leg, not
 * the `*Collection` path. No marketplace fee, no EIP-2981 royalty: those are only
 * applied by the Router's `*Collection` entry points (RoyaltyHelper is invoked
 * exclusively from there); a plain `getAmountsIn` leg is pure AMM curve, and a
 * fractional amount has no tokenId to ask `royaltyInfo` about. */
async function quoteBuyFungible(
  ctx: SnfClientContext,
  args: QuoteBuyArgs,
  collection: CollectionInfo,
  pool: PoolRef,
): Promise<Quote> {
  const amount = args.amount as bigint
  const routerAbi = ctx.chain.routerVariant === 'native-erc20' ? ROUTER_NATIVE_ERC20_ABI : ROUTER02_COLLECTION_ABI
  const base = pool.baseToken.address ?? ctx.chain.quoteToken
  const path = buildWnftRoutePath({ wrapper: collection.wrapper, baseToken: base, side: 'buy' })

  const results = await ctx.publicClient.multicall({
    contracts: [{ address: ctx.chain.router02, abi: routerAbi, functionName: 'getAmountsIn', args: [amount, path] }],
    allowFailure: true,
    multicallAddress: ctx.chain.multicall3,
    batchSize: 0,
  })
  const result = results[0]
  if (result?.status !== 'success') {
    throw new SnfError('NO_ROUTE', 'Could not read getAmountsIn for the wNFT fungible leg', {
      details: { pair: pool.pair },
    })
  }
  const amounts = result.result
  const routerCost = amounts[0]
  if (routerCost === undefined) {
    throw new SnfError('NO_ROUTE', 'getAmountsIn returned an empty amounts[] array', { details: { pair: pool.pair } })
  }

  const localCost = getAmountIn(amount, pool.reserves.base, pool.reserves.wnft, BigInt(ctx.chain.poolNetFee))
  if (localCost === undefined) {
    throw new SnfError('NO_ROUTE', 'This pool cannot fill the requested wNFT amount', { details: { pair: pool.pair } })
  }
  // The fungible leg has no separate marketplace/royalty component to reconstruct
  // — reusing reconcileGross with both at 0n still proves the local bigint port of
  // the curve matches the Router's own on-chain answer to the wei.
  reconcileGross({ pool: localCost, marketplace: 0n, royalty: 0n, routerGross: routerCost })

  const chainId = ctx.chain.chainId
  const poolBps = 10_000 - ctx.chain.poolNetFee
  const fees: FeeBreakdown = {
    pool: { bps: poolBps, note: 'included in curve' },
    marketplace: { ...toQuoteAmount(chainId, 0n), bps: 0 },
    royalty: { ...toQuoteAmount(chainId, 0n), bps: 0, capApplied: false },
  }
  const leg: QuoteLeg = {
    pair: pool.pair,
    count: 0,
    amount: toQuoteAmount(chainId, routerCost),
    path,
    feeBps: poolBps,
    kind: 'wnft',
    side: 'buy',
  }

  return {
    side: 'buy',
    chainId,
    collection: collection.address,
    legs: [leg],
    fees,
    totalCost: toQuoteAmount(chainId, routerCost),
    priceImpact: buyPriceImpact(pool.reserves, routerCost, amount),
    deliverable: 0,
    bestEffort: false,
    expiresAt: new Date(Date.now() + QUOTE_TTL_MS).toISOString(),
    reconciled: true,
  }
}

export async function quoteBuy(ctx: SnfClientContext, args: QuoteBuyArgs): Promise<Quote> {
  validateArgs(args)

  const collection = await resolveCollection(ctx, args.collection)
  if (collection.pools.length === 0) {
    throw new SnfError('NO_ROUTE', 'No pool exists for this collection', {
      details: { collection: args.collection, viablePayTokens: [] },
    })
  }

  const pool = pickPool(collection.pools, args.payToken)
  if (!pool) {
    throw new SnfError('NO_ROUTE', 'No pool for the requested payToken', {
      details: { viablePayTokens: filterViablePayTokens({ candidates: collection.pools }) },
    })
  }

  if (args.amount !== undefined) {
    return quoteBuyFungible(ctx, args, collection, pool)
  }

  let tokenIds: readonly string[]
  let requested: number
  if (args.tokenIds !== undefined) {
    tokenIds = normalizeTokenIds(args.tokenIds)
    requested = tokenIds.length
  } else {
    const count = args.count as number
    const availableCount = availableCountFromReserve(pool.reserves.wnft)
    if (availableCount === 0) {
      throw new SnfError('NO_ROUTE', 'This pool currently has nothing available to buy', {
        details: { pair: pool.pair },
      })
    }
    const inventory = await poolInventory(ctx, pool.pair)
    const deliverableCount = Math.min(count, availableCount, inventory.tokenIds.length)
    tokenIds = inventory.tokenIds.slice(0, deliverableCount)
    requested = count
  }

  const deliverable = tokenIds.length
  if (deliverable === 0) {
    throw new SnfError('NO_ROUTE', 'No tokenIds could be resolved for this buy', {
      details: { collection: args.collection },
    })
  }
  const bestEffort = deliverable < requested

  const ctxData = await loadQuoteContext(ctx, {
    pair: pool.pair,
    wrapper: collection.wrapper,
    collection: collection.address,
    baseToken: pool.baseToken,
    tokenIds,
    side: 'buy',
  })

  const isArc = ctx.chain.routerVariant === 'native-erc20'
  const royaltyRaw = ctxData.perIdRoyalty.reduce((sum, line) => sum + line.amount, 0n)
  const unpayable = ctxData.perIdRoyalty.reduce(
    (sum, line) => sum + (isZeroAddress(line.receiver) ? line.amount : 0n),
    0n,
  )
  // Arc's Router variant drops an unpayable (zero-address) EIP-2981 receiver's
  // share from what's CHARGED to a buyer — never charged, so never reconstructed
  // here either (RESEARCH § "The Arc NativeERC20 variant").
  const royaltyCharged = isArc ? royaltyRaw - unpayable : royaltyRaw
  const marketplace = (ctxData.poolLeg * ctxData.marketplaceFeeE18) / ONE_E18

  reconcileGross({
    pool: ctxData.poolLeg,
    marketplace,
    royalty: royaltyCharged,
    routerGross: ctxData.routerTotal,
  })

  const chainId = ctx.chain.chainId
  const poolBps = 10_000 - ctx.chain.poolNetFee
  const marketplaceBps = marketplace > 0n ? bpsFromRatio(marketplace, ctxData.poolLeg) : 0
  const royaltyBps = royaltyCharged > 0n ? bpsFromRatio(royaltyCharged, ctxData.poolLeg) : 0

  const fees: FeeBreakdown = {
    pool: { bps: poolBps, note: 'included in curve' },
    marketplace: { ...toQuoteAmount(chainId, marketplace), bps: marketplaceBps },
    // capApplied is always false in v1: capRoyaltyFee is pinned false, so the
    // Router itself always evaluates the cap as "100%" (no-op) — see
    // math/quoteMath.ts's reconstructRoyalty header.
    royalty: { ...toQuoteAmount(chainId, royaltyCharged), bps: royaltyBps, capApplied: false },
  }

  const baseAddress = pool.baseToken.address ?? ctx.chain.quoteToken
  const path = buildNftRoutePath({ collection: collection.address, baseToken: baseAddress, side: 'buy' })
  const leg: QuoteLeg = {
    pair: pool.pair,
    count: deliverable,
    amount: toQuoteAmount(chainId, ctxData.routerTotal),
    path,
    feeBps: poolBps,
    kind: pool.baseToken.isNative ? 'native' : 'erc20',
    side: 'buy',
  }

  const warnings: string[] = []
  if (isArc && unpayable > 0n) {
    warnings.push(
      "This collection's EIP-2981 receiver is the zero address for one or more items — the Router does not charge that share to the buyer (Arc _unpayableRoyalties).",
    )
  }

  return {
    side: 'buy',
    chainId,
    collection: collection.address,
    count: deliverable,
    tokenIds,
    legs: [leg],
    fees,
    totalCost: toQuoteAmount(chainId, ctxData.routerTotal),
    priceImpact: buyPriceImpact(ctxData.reserves, ctxData.poolLeg, wnftUnitsFromCount(deliverable)),
    deliverable,
    bestEffort,
    expiresAt: new Date(Date.now() + QUOTE_TTL_MS).toISOString(),
    reconciled: true,
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}
