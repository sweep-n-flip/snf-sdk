import type { Abi } from 'viem'

import { IERC2981_ABI } from '../abis/IERC2981'
import { PAIR_ABI } from '../abis/UniswapV2Pair'
import { ROUTER02_COLLECTION_ABI } from '../abis/UniswapV2Router02Collection'
import { ROUTER_NATIVE_ERC20_ABI } from '../abis/UniswapV2Router01CollectionNativeERC20'
import { WERC721_ABI } from '../abis/WERC721'
import { SnfError } from '../errors'
import { resolveWrapperSide } from '../routing/nftRoutePaths'
import { wnftUnitsFromCount } from '../routing/wnftPathScale'
import type { TokenRef } from '../types/amount.types'
import type { SnfClientContext } from '../types/client.types'

/**
 * `loadQuoteContext` — every on-chain input a `quoteBuy`/`quoteSell` call needs,
 * pinned to ONE block (R8, R11; 54-SPEC.md). Merges the reads spread across
 * `snf-client`'s `useNFTBuyQuote`/`useNFTSellQuote`/`useRouterFees`/
 * `useRouterRoyaltyCap`/`useReserves` into two multicalls: round 1 (reserves,
 * `token0`/`token1`, wrapper `decimals()`, `marketplaceFee()`, `royaltyFeeCap()`,
 * the Router's own `*Collection` gross/net, and the plain wrapper-leg `poolLeg`) and
 * round 2 (per-id `royaltyInfo` at the REAL sale price, which can only be computed
 * once round 1's `poolLeg` is known — a genuine sequential dependency, not an
 * oversight, exactly like plan 11's `poolInventory` two-batch precedent). Both
 * rounds are pinned to the SAME `blockNumber` (read once, BEFORE round 1, then
 * passed explicitly to both multicalls) so the whole context describes one
 * consistent block despite the two round trips.
 *
 * `capRoyaltyFee` is the literal `false` at both `getAmountsInCollection`/
 * `getAmountsOutCollection` call sites below (SPEC prohibition #7): with
 * `royaltyFeeCap()` unset (0 = no cap on-chain), passing `true` would silently pay
 * the creator nothing. This function never sends `true`.
 *
 * Everything this function returns is on the POOL axis (`getQuoteDecimals(chainId)`
 * — 6 on Arc, 18 elsewhere) — never an 18-decimal EVM-axis literal; the EVM axis is
 * derived only by `build/` (plan 15) via `toNativeValue`.
 */

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as `0x${string}`

/** Loosely-typed multicall call shape — see `collection/royalty.ts`'s identical
 * comment: viem's per-position tuple inference cannot precisely type-check a batch
 * built from a fixed prefix plus a `.map()`-derived tail. */
interface Call {
  readonly address: `0x${string}`
  readonly abi: Abi
  readonly functionName: string
  readonly args: readonly unknown[]
}
type CallResult = { readonly status: 'success' | 'failure'; readonly result?: unknown }

export interface LoadQuoteContextArgs {
  readonly pair: `0x${string}`
  readonly wrapper: `0x${string}`
  readonly collection: `0x${string}`
  /** The pool's concrete base-token identity (never `null` — a `PoolRef.baseToken`
   * from `resolveCollection` always carries a real address, even for the native
   * side — see `routing/routing.types.ts`'s `PoolRef` doc comment). */
  readonly baseToken: TokenRef
  readonly tokenIds: readonly string[]
  readonly side: 'buy' | 'sell'
}

/** One tokenId's on-chain `royaltyInfo` read, ALREADY at the real sale price — the
 * raw amount, never re-derived through a rate (see this module's header: deriving a
 * "rate" from `amount/salePrice` and re-multiplying loses up to 1 wei on some
 * inputs, which would break R8's `===` reconciliation; the raw amount is exact by
 * construction). A read that fails/reverts (the collection does not implement
 * IERC2981 for this id) maps to `amount: 0n` — exactly `RoyaltyHelper.sol`'s own
 * non-IERC2981, marketplace-fee-only branch. */
export interface QuoteRoyaltyLine {
  readonly tokenId: string
  readonly receiver: `0x${string}`
  readonly amount: bigint
}

export interface QuoteContext {
  readonly blockNumber: bigint
  readonly reserves: { readonly base: bigint; readonly wnft: bigint }
  readonly wrapperIsToken0: boolean
  readonly wrapperDecimals: number
  /**
   * The pool axis's own decimals (`ctx.chain.quoteDecimals` — 6 on Arc, 18
   * elsewhere), recorded here so downstream code never has to guess which axis
   * `reserves`/`poolLeg`/`routerTotal` are expressed in.
   */
  readonly quoteDecimals: number
  /**
   * `Router.marketplaceFee()`, live-read, `1e18` scale.
   */
  readonly marketplaceFeeE18: bigint
  /**
   * `Router.royaltyFeeCap(collection)`, live-read, `1e18` scale. Not consumed by
   * the reconciliation math (`capRoyaltyFee` is pinned `false`, which the Router
   * itself encodes as "no cap" — see `math/quoteMath.ts`'s `reconstructRoyalty`
   * doc) — exposed for display/context only.
   */
  readonly royaltyCapE18: bigint
  /** The plain (non-`Collection`) Router read on the wrapper leg — the AMM curve
   * cost/proceeds with NO marketplace fee and NO royalty on top. The reconstruction
   * starts here. */
  readonly poolLeg: bigint
  /** The Router's own `*Collection` answer — GROSS (buy) or NET (sell). Never
   * re-derived; `quoteBuy`/`quoteSell` reconcile against this verbatim. */
  readonly routerTotal: bigint
  readonly perIdRoyalty: readonly QuoteRoyaltyLine[]
}

function readResult<T>(result: CallResult | undefined, field: string): T {
  if (result?.status !== 'success') {
    throw new SnfError('NO_ROUTE', `Could not read ${field} while loading the quote context`, {
      details: { field },
    })
  }
  return result.result as T
}

function firstAmount(amounts: readonly bigint[], field: string): bigint {
  const v = amounts[0]
  if (v === undefined) {
    throw new SnfError('NO_ROUTE', `${field} returned an empty amounts[] array`, { details: { field } })
  }
  return v
}

function lastAmount(amounts: readonly bigint[], field: string): bigint {
  const v = amounts[amounts.length - 1]
  if (v === undefined) {
    throw new SnfError('NO_ROUTE', `${field} returned an empty amounts[] array`, { details: { field } })
  }
  return v
}

export async function loadQuoteContext(
  ctx: SnfClientContext,
  args: LoadQuoteContextArgs,
): Promise<QuoteContext> {
  const { pair, wrapper, collection, baseToken, tokenIds, side } = args
  const base = baseToken.address ?? ctx.chain.quoteToken
  const routerAbi = ctx.chain.routerVariant === 'native-erc20' ? ROUTER_NATIVE_ERC20_ABI : ROUTER02_COLLECTION_ABI
  const tokenIdsBig = tokenIds.map((id) => BigInt(id))
  const units = wnftUnitsFromCount(tokenIds.length)

  // Read the block ONCE, before round 1 — both multicalls below are pinned to this
  // exact block, so round 2 (which needs round 1's poolLeg first) still describes
  // the same on-chain snapshot as round 1, despite the two round trips.
  const blockNumber = await ctx.publicClient.getBlockNumber()

  const round1Contracts: readonly Call[] = [
    { address: pair, abi: PAIR_ABI, functionName: 'getReserves', args: [] },
    { address: pair, abi: PAIR_ABI, functionName: 'token0', args: [] },
    { address: pair, abi: PAIR_ABI, functionName: 'token1', args: [] },
    { address: wrapper, abi: WERC721_ABI, functionName: 'decimals', args: [] },
    { address: ctx.chain.router02, abi: routerAbi, functionName: 'marketplaceFee', args: [] },
    { address: ctx.chain.router02, abi: routerAbi, functionName: 'royaltyFeeCap', args: [collection] },
    side === 'buy'
      ? {
          address: ctx.chain.router02,
          abi: routerAbi,
          functionName: 'getAmountsInCollection',
          // capRoyaltyFee pinned false (SPEC prohibition #7).
          args: [tokenIdsBig, [base, collection], false],
        }
      : {
          address: ctx.chain.router02,
          abi: routerAbi,
          functionName: 'getAmountsOutCollection',
          // capRoyaltyFee pinned false (SPEC prohibition #7).
          args: [tokenIdsBig, [collection, base], false],
        },
    side === 'buy'
      ? { address: ctx.chain.router02, abi: routerAbi, functionName: 'getAmountsIn', args: [units, [base, wrapper]] }
      : { address: ctx.chain.router02, abi: routerAbi, functionName: 'getAmountsOut', args: [units, [wrapper, base]] },
  ]

  const round1: readonly CallResult[] = await ctx.publicClient.multicall({
    contracts: round1Contracts,
    allowFailure: true,
    multicallAddress: ctx.chain.multicall3,
    batchSize: 0,
    blockNumber,
  })

  const [reserve0, reserve1] = readResult<readonly [bigint, bigint, number]>(round1[0], 'getReserves')
  const token0 = readResult<`0x${string}`>(round1[1], 'token0')
  const token1 = readResult<`0x${string}`>(round1[2], 'token1')
  // WERC721.decimals() is `uint8` — viem decodes it as a plain `number` directly
  // (no bigint->number coercion needed, unlike a uint256 read).
  const wrapperDecimals = readResult<number>(round1[3], 'wrapper decimals')
  const marketplaceFeeE18 = readResult<bigint>(round1[4], 'marketplaceFee')
  const royaltyCapE18 = readResult<bigint>(round1[5], 'royaltyFeeCap')
  const collectionField = side === 'buy' ? 'getAmountsInCollection' : 'getAmountsOutCollection'
  const collectionAmounts = readResult<readonly bigint[]>(round1[6], collectionField)
  const plainField = side === 'buy' ? 'getAmountsIn' : 'getAmountsOut'
  const plainAmounts = readResult<readonly bigint[]>(round1[7], plainField)

  if (wrapperDecimals !== 18) {
    throw new SnfError('WRAPPER_UNVERIFIED', `WERC721.decimals() returned ${wrapperDecimals}, expected 18`, {
      details: { wrapper, wrapperDecimals },
    })
  }

  const { wrapperIsToken0 } = resolveWrapperSide({ pair, token0, token1, baseToken })
  const reserves = wrapperIsToken0 ? { base: reserve1, wnft: reserve0 } : { base: reserve0, wnft: reserve1 }

  const routerTotal =
    side === 'buy' ? firstAmount(collectionAmounts, collectionField) : lastAmount(collectionAmounts, collectionField)
  const poolLeg = side === 'buy' ? firstAmount(plainAmounts, plainField) : lastAmount(plainAmounts, plainField)

  // Round 2 — royaltyInfo per id, at the REAL sale price (poolLeg / itemCount,
  // truncated ONCE and reused for every id — RoyaltyHelper.sol:33). Pinned to
  // round 1's own blockNumber, not a fresh "latest" read.
  const salePrice = poolLeg / BigInt(tokenIds.length)
  const round2Contracts: readonly Call[] = tokenIdsBig.map((id) => ({
    address: collection,
    abi: IERC2981_ABI,
    functionName: 'royaltyInfo',
    args: [id, salePrice],
  }))
  const round2: readonly CallResult[] = await ctx.publicClient.multicall({
    contracts: round2Contracts,
    allowFailure: true,
    multicallAddress: ctx.chain.multicall3,
    batchSize: 0,
    blockNumber,
  })

  const perIdRoyalty: readonly QuoteRoyaltyLine[] = tokenIds.map((tokenId, i) => {
    const r = round2[i]
    if (r?.status !== 'success' || !Array.isArray(r.result) || r.result.length < 2) {
      return { tokenId, receiver: ZERO_ADDRESS, amount: 0n }
    }
    const [receiver, amount] = r.result as unknown as readonly [`0x${string}`, bigint]
    return { tokenId, receiver, amount }
  })

  return {
    blockNumber,
    reserves,
    wrapperIsToken0,
    wrapperDecimals,
    quoteDecimals: ctx.chain.quoteDecimals,
    marketplaceFeeE18,
    royaltyCapE18,
    poolLeg,
    routerTotal,
    perIdRoyalty,
  }
}
