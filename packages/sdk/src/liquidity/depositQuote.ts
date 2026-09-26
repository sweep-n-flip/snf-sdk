import { assertParam, SnfError } from '../errors'
import { toAmount, toPoolAmount } from '../format'
import { mintLiquidity, toPairOrder } from './liquidityMath'
import type { SnfChainId } from '../chains/chains.types'
import type { LiquidityQuoteDetails } from '../types/liquidity.types'
import type { FeeBreakdown, Quote } from '../types/quote.types'
import type { DepositPoolState } from './poolState.types'

/**
 * `depositQuote` — the shared plumbing every deposit-side quote composes: the
 * base-identity guard every deposit target must pass, the pair-order-aware LP-mint
 * computation, and the one `Quote` constructor that turns a resolved
 * `DepositPoolState` plus the deposit's own figures into the frozen, zero-fee
 * liquidity `Quote` shape `quoteAddLiquidity`, `quoteCreatePool` and (later)
 * `buildSeed` all return.
 */

const LP_DECIMALS = 18
const LP_SYMBOL = 'LP'
const QUOTE_TTL_MS = 30_000

/**
 * The first of the three base-identity guards — a PURE address comparison, called
 * BEFORE `loadDepositState` ever runs. This has to happen first: the raw NFT
 * collection contract has no ERC-20 `decimals()`, so if this check ran only after
 * loading state, the loader's own generic "baseToken does not implement ERC-20
 * decimals()" failure would fire first and mask the specific, more helpful reason
 * this function reports.
 */
export function assertBaseNotCollection(
  collection: `0x${string}`,
  baseToken: `0x${string}` | null | undefined,
): void {
  if (baseToken === null || baseToken === undefined) return
  if (baseToken.toLowerCase() === collection.toLowerCase()) {
    throw new SnfError(
      'INVALID_PARAMS',
      'baseToken must be an ERC-20 token — it cannot be the raw NFT collection address itself',
      { details: { field: 'baseToken', reason: 'base-is-collection' } },
    )
  }
}

/**
 * The remaining two base-identity guards, which DO need on-chain state: this SAME
 * collection's own wrapper, or ANY OTHER collection's wrapper, used as the ERC-20
 * base. The Router itself accepts both (no on-chain access control blocks a
 * wrapper-as-base pair), but both are a client-side policy this package enforces,
 * matching the reference production app's own rule. A native-base deposit never
 * reaches this check at all. Call `assertBaseNotCollection` first — see its own doc
 * comment for why the ordering matters.
 */
export function assertBaseNotWrapper(state: DepositPoolState): void {
  if (state.isNative) return
  const baseAddress = state.baseToken.address
  if (baseAddress === null) {
    throw new SnfError(
      'UNKNOWN',
      'internal: a non-native DepositPoolState carried a null baseToken address',
    )
  }
  const baseLower = baseAddress.toLowerCase()
  if (state.wrapper !== null && baseLower === state.wrapper.toLowerCase()) {
    throw new SnfError(
      'INVALID_PARAMS',
      "baseToken cannot be this same collection's own wrapper",
      { details: { field: 'baseToken', reason: 'base-is-own-wrapper' } },
    )
  }
  if (state.baseIsWrapper) {
    throw new SnfError(
      'INVALID_PARAMS',
      "baseToken cannot be another collection's wrapper",
      { details: { field: 'baseToken', reason: 'base-is-other-wrapper' } },
    )
  }
}

export interface DepositMintAmountsResult {
  readonly amount0: bigint
  readonly amount1: bigint
  readonly reserve0: bigint
  readonly reserve1: bigint
}

/**
 * The exact `{amount0, amount1, reserve0, reserve1}` `Pair.mint` computes its LP
 * output from — deposit + the pair's own stray balance surplus over its cached
 * reserve, in pair-slot order. When `state.pair` does not exist yet there is no
 * ordering to resolve, and none is needed: `mintLiquidity`'s own first-deposit
 * branch (`floorSqrt(amount0 * amount1)`) is symmetric in its two inputs, so
 * whichever address the Factory's wrapper deployment eventually gets can never
 * change this figure.
 */
export function depositMintAmounts(
  state: DepositPoolState,
  depositWnft: bigint,
  depositBase: bigint,
): DepositMintAmountsResult {
  if (state.pair === null) {
    return { amount0: depositWnft, amount1: depositBase, reserve0: 0n, reserve1: 0n }
  }
  if (state.wrapperIsToken0 === null) {
    throw new SnfError('UNKNOWN', 'internal: an existing pair carried a null wrapperIsToken0')
  }
  const depositOrder = toPairOrder(state.wrapperIsToken0, { base: depositBase, wnft: depositWnft })
  const balanceOrder = toPairOrder(state.wrapperIsToken0, state.balances)
  const reserveOrder = toPairOrder(state.wrapperIsToken0, state.reserves)
  return {
    amount0: depositOrder.v0 + balanceOrder.v0 - reserveOrder.v0,
    amount1: depositOrder.v1 + balanceOrder.v1 - reserveOrder.v1,
    reserve0: reserveOrder.v0,
    reserve1: reserveOrder.v1,
  }
}

/**
 * `mintLiquidity` over `depositMintAmounts`, with the "would mint nothing" guard
 * every deposit quote needs — a non-positive result means the real `Pair.mint` call
 * would revert `INSUFFICIENT_LIQUIDITY_MINTED` on-chain, so this throws
 * `INVALID_PARAMS` before ever constructing a `Quote` around it.
 */
export function computeLpOut(state: DepositPoolState, depositWnft: bigint, depositBase: bigint): bigint {
  const { amount0, amount1, reserve0, reserve1 } = depositMintAmounts(state, depositWnft, depositBase)
  const lpOut = mintLiquidity({ amount0, amount1, reserve0, reserve1, totalSupply: state.totalSupply })
  assertParam(lpOut > 0n, 'This deposit would mint zero (or negative) LP — increase the deposit size.', {
    field: 'liquidity',
    reason: 'insufficient-liquidity-minted',
  })
  return lpOut
}

function zeroLiquidityFees(baseToken: DepositPoolState['baseToken']): FeeBreakdown {
  return {
    pool: { bps: 0, note: 'no fee applies to a liquidity deposit or withdrawal' },
    marketplace: { ...toPoolAmount(baseToken, 0n), bps: 0 },
    royalty: { ...toPoolAmount(baseToken, 0n), bps: 0, capApplied: false },
  }
}

export interface DepositQuoteArgs {
  readonly side: 'add-liquidity' | 'create-pool'
  readonly chainId: SnfChainId
  readonly state: DepositPoolState
  readonly nftCount: number
  readonly tokenIds: readonly string[]
  /** The base the Router actually takes at `state.blockNumber` — an existing-pool
   * add's Router-reconciled figure, or a create's own caller-chosen `baseAmount`. */
  readonly baseRequired: bigint
  /** ERC-20 add only: the ceil amount an allowance/approval must cover. */
  readonly baseDesired?: bigint
  readonly lpOut: bigint
  /** Create only: `baseAmount / nftCount`, display only. */
  readonly pricePerNft?: bigint
}

/** The one `Quote` constructor every deposit path shares — see this file's header. */
export function buildDepositQuote(args: DepositQuoteArgs): Quote {
  const { side, chainId, state, nftCount, tokenIds, baseRequired, baseDesired, lpOut, pricePerNft } = args
  const liquidity: LiquidityQuoteDetails = {
    pair: state.pair,
    wrapper: state.wrapper,
    baseToken: state.baseToken,
    wrapperIsToken0: state.wrapperIsToken0,
    reserves: state.reserves,
    totalSupply: state.totalSupply,
    blockNumber: state.blockNumber,
    nftCount,
    baseRequired: toPoolAmount(state.baseToken, baseRequired),
    ...(baseDesired !== undefined ? { baseDesired: toPoolAmount(state.baseToken, baseDesired) } : {}),
    ...(pricePerNft !== undefined ? { pricePerNft: toPoolAmount(state.baseToken, pricePerNft) } : {}),
    lpOut: toAmount(lpOut, LP_DECIMALS, LP_SYMBOL),
    feeToZero: true,
  }
  return {
    side,
    chainId,
    collection: state.collection,
    tokenIds,
    legs: [],
    fees: zeroLiquidityFees(state.baseToken),
    liquidity,
    totalCost: toPoolAmount(state.baseToken, baseRequired),
    priceImpact: 0,
    deliverable: nftCount,
    bestEffort: false,
    expiresAt: new Date(Date.now() + QUOTE_TTL_MS).toISOString(),
    reconciled: true,
  }
}
