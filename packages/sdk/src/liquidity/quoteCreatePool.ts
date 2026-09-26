import { MAX_TOKEN_IDS, MIN_NEW_POOL_NFTS, assertTokenIdList } from '../build/validate'
import { assertChainMatch, assertParam, SnfError } from '../errors'
import { assertBaseNotCollection, assertBaseNotWrapper, buildDepositQuote, computeLpOut } from './depositQuote'
import { ONE_WNFT } from './liquidityMath'
import { loadDepositState } from './poolState'
import type { SnfClientContext } from '../types/client.types'
import type { QuoteCreatePoolArgs } from '../types/liquidity.types'
import type { Quote } from '../types/quote.types'

/**
 * On-chain-reconciled quote for a deposit that CREATES a pool (or seeds an existing,
 * still-empty one) — the caller's own `baseAmount` sets the pool's opening price,
 * never a figure read back from anywhere else (the identity-only quote pattern this
 * package's `build*` functions rely on has nothing to re-derive here: the price IS
 * the caller's choice). `quoteAddLiquidity` is the sibling for a pool that already
 * has liquidity; deciding which applies is made from LIVE RESERVES, never from
 * whether a `getPair` slot happens to be non-zero.
 */

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

export async function quoteCreatePool(ctx: SnfClientContext, args: QuoteCreatePoolArgs): Promise<Quote> {
  assertChainMatch(args.chainId, ctx.chain.chainId)
  const tokenIds = assertTokenIdList(args.tokenIds, { field: 'tokenIds', min: MIN_NEW_POOL_NFTS })
  assertParam(
    tokenIds.length <= MAX_TOKEN_IDS,
    `A single create-pool deposit accepts at most ${MAX_TOKEN_IDS} tokenIds — call buildSeed for a launch larger than that`,
    { field: 'tokenIds', max: MAX_TOKEN_IDS },
  )
  assertParam(args.baseAmount > 0n, 'baseAmount must be a positive bigint', {
    field: 'baseAmount',
    value: args.baseAmount,
  })
  const nftCount = tokenIds.length
  assertBaseNotCollection(args.collection, args.baseToken)

  const state = await loadDepositState(ctx, {
    collection: args.collection,
    ...(args.baseToken !== undefined ? { baseToken: args.baseToken } : {}),
  })
  assertBaseNotWrapper(state)

  if (state.pair !== null && (state.reserves.base > 0n || state.reserves.wnft > 0n)) {
    throw new SnfError('INVALID_PARAMS', 'This pool already has liquidity — call quoteAddLiquidity instead.', {
      details: { field: 'collection', reason: 'pool-has-liquidity' },
    })
  }
  if (state.feeTo.toLowerCase() !== ZERO_ADDRESS) {
    throw new SnfError(
      'QUOTE_RECONCILIATION_FAILED',
      "This pool's Factory has a live protocol fee — this package's fee-off mint mirror does not apply.",
      { details: { reason: 'protocol-fee-on', feeTo: state.feeTo } },
    )
  }

  const depositWnft = BigInt(nftCount) * ONE_WNFT
  const lpOut = computeLpOut(state, depositWnft, args.baseAmount)
  const pricePerNft = args.baseAmount / BigInt(nftCount)

  return buildDepositQuote({
    side: 'create-pool',
    chainId: ctx.chain.chainId,
    state,
    nftCount,
    tokenIds,
    baseRequired: args.baseAmount,
    lpOut,
    pricePerNft,
  })
}
