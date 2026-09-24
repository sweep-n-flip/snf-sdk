import type { Abi } from 'viem'

import { ERC20_ABI } from '../abis/ERC20'
import { FACTORY_ABI } from '../abis/UniswapV2Factory'
import { PAIR_ABI } from '../abis/UniswapV2Pair'
import { ROUTER02_COLLECTION_ABI } from '../abis/UniswapV2Router02Collection'
import { ROUTER_NATIVE_ERC20_ABI } from '../abis/UniswapV2Router01CollectionNativeERC20'
import { assertChainMatch, SnfError, assertParam } from '../errors'
import { toAmount, toQuoteAmount } from '../format'
import { getAmountsInChain, getAmountsOutChain } from '../math/quoteMath'
import { crossPoolPriceImpact, singlePoolPriceImpact } from './priceImpact'
import type { SnfClientContext } from '../types/client.types'
import type { Amount } from '../types/amount.types'
import type { FeeBreakdown, Quote, QuoteLeg, QuoteSwapArgs } from '../types/quote.types'

/**
 * Fungible↔fungible quote: delegate-aware per hop — `9800` on a native SnF pair,
 * that CHAIN'S OWN `delegateNetFee` on a delegated pair (`Factory.delegates(token0,
 * token1)`, a bare `bool`), NEVER a single hardcoded upstream-DEX constant.
 *
 * ROUTING SCOPE (v1): a direct pair `[tokenIn, tokenOut]`, or one intermediate hop via
 * the chain's own `quoteToken`. `args.directOnly === true` forbids the second form —
 * `NO_ROUTE` with `details.viablePayTokens` naming the quote token as the only
 * alternative, rather than a silently multi-hopped quote. Every computed amount is
 * cross-checked against the Router's own `getAmountsOut`/`getAmountsIn` for the
 * identical path — a mismatch throws `QUOTE_RECONCILIATION_FAILED` (the same reconciliation discipline every quote function follows).
 */

const QUOTE_TTL_MS = 30_000

interface Call {
  readonly address: `0x${string}`
  readonly abi: Abi
  readonly functionName: string
  readonly args: readonly unknown[]
}
type CallResult = { readonly status: 'success' | 'failure'; readonly result?: unknown }

const isZeroAddress = (address: `0x${string}`): boolean => /^0x0+$/i.test(address)
const normalizeAddr = (t: `0x${string}` | null, quoteToken: `0x${string}`): `0x${string}` => t ?? quoteToken

function validateArgs(args: QuoteSwapArgs, quoteToken: `0x${string}`): void {
  const hasIn = args.amountIn !== undefined
  const hasOut = args.amountOut !== undefined
  assertParam(hasIn !== hasOut, 'quoteSwap requires exactly one of amountIn or amountOut', {
    field: 'amountIn|amountOut',
  })
  if (hasIn) assertParam((args.amountIn) > 0n, 'amountIn must be a positive bigint', { field: 'amountIn' })
  if (hasOut) assertParam((args.amountOut) > 0n, 'amountOut must be a positive bigint', { field: 'amountOut' })
  const addrOk = (t: `0x${string}` | null): boolean => t === null || /^0x[0-9a-fA-F]{40}$/.test(t)
  assertParam(addrOk(args.tokenIn), 'tokenIn must be a well-formed 0x address or null', { field: 'tokenIn' })
  assertParam(addrOk(args.tokenOut), 'tokenOut must be a well-formed 0x address or null', { field: 'tokenOut' })
  const inAddr = normalizeAddr(args.tokenIn, quoteToken).toLowerCase()
  const outAddr = normalizeAddr(args.tokenOut, quoteToken).toLowerCase()
  assertParam(inAddr !== outAddr, 'tokenIn and tokenOut must be different tokens', { field: 'tokenIn|tokenOut' })
}

/** The quote token's decimals/symbol come from the registry (no RPC round trip); any
 * other address is a real ERC20 `decimals()`/`symbol()` read. */
async function resolveTokenMeta(
  ctx: SnfClientContext,
  address: `0x${string}`,
): Promise<{ readonly decimals: number; readonly symbol: string }> {
  if (address.toLowerCase() === ctx.chain.quoteToken.toLowerCase()) {
    return { decimals: ctx.chain.quoteDecimals, symbol: ctx.chain.nativeSymbol }
  }
  const results = await ctx.publicClient.multicall({
    contracts: [
      { address, abi: ERC20_ABI, functionName: 'decimals', args: [] },
      { address, abi: ERC20_ABI, functionName: 'symbol', args: [] },
    ],
    allowFailure: true,
    multicallAddress: ctx.chain.multicall3,
    batchSize: 0,
  })
  const decimalsResult = results[0]
  const symbolResult = results[1]
  const decimals = decimalsResult?.status === 'success' ? (decimalsResult.result) : 18
  const symbol = symbolResult?.status === 'success' ? (symbolResult.result) : 'TOKEN'
  return { decimals, symbol }
}

/** Resolves the `pair` for every hop of both candidate paths in ONE multicall; picks
 * direct when it resolves, else via-quoteToken, else `undefined` (no route). */
async function resolvePath(
  ctx: SnfClientContext,
  inAddr: `0x${string}`,
  outAddr: `0x${string}`,
  quoteToken: `0x${string}`,
): Promise<{ readonly path: readonly `0x${string}`[]; readonly pairs: readonly `0x${string}`[]; readonly directAvailable: boolean } | undefined> {
  const direct: readonly [`0x${string}`, `0x${string}`] = [inAddr, outAddr]
  const viaQuote: readonly [`0x${string}`, `0x${string}`, `0x${string}`] | undefined =
    inAddr.toLowerCase() !== quoteToken.toLowerCase() && outAddr.toLowerCase() !== quoteToken.toLowerCase()
      ? [inAddr, quoteToken, outAddr]
      : undefined

  const hopPairs: readonly [`0x${string}`, `0x${string}`][] = [
    [direct[0], direct[1]],
    ...(viaQuote ? [[viaQuote[0], viaQuote[1]] as [`0x${string}`, `0x${string}`], [viaQuote[1], viaQuote[2]] as [`0x${string}`, `0x${string}`]] : []),
  ]
  const contracts: readonly Call[] = hopPairs.map(([a, b]) => ({ address: ctx.chain.factory, abi: FACTORY_ABI, functionName: 'getPair', args: [a, b] }))
  const results: readonly CallResult[] = await ctx.publicClient.multicall({
    contracts,
    allowFailure: true,
    multicallAddress: ctx.chain.multicall3,
    batchSize: 0,
  })

  const pairAt = (i: number): `0x${string}` | undefined => {
    const r = results[i]
    if (r?.status !== 'success') return undefined
    const p = r.result as `0x${string}`
    return isZeroAddress(p) ? undefined : p
  }

  const directPair = pairAt(0)
  if (directPair) return { path: direct, pairs: [directPair], directAvailable: true }

  if (viaQuote) {
    const pairA = pairAt(1)
    const pairB = pairAt(2)
    if (pairA && pairB) return { path: viaQuote, pairs: [pairA, pairB], directAvailable: false }
  }
  return undefined
}

interface HopContext {
  readonly reserveIn: bigint
  readonly reserveOut: bigint
  readonly netFee: bigint
  /** Same fee as the registry's own plain `number` — never round-tripped through
   * bigint→`Number()` (src/quote/'s static scan bans that narrowing). */
  readonly netFeeBps: number
}

/** One multicall: `getReserves`/`token0` (aligns reserveIn/reserveOut with hop
 * direction) + `Factory.delegates(from,to)` for every hop of the CHOSEN path. */
async function loadHops(
  ctx: SnfClientContext,
  path: readonly `0x${string}`[],
  pairs: readonly `0x${string}`[],
): Promise<readonly HopContext[]> {
  const contracts: Call[] = pairs.flatMap((pair, i) => [
    { address: pair, abi: PAIR_ABI, functionName: 'getReserves', args: [] },
    { address: pair, abi: PAIR_ABI, functionName: 'token0', args: [] },
    { address: ctx.chain.factory, abi: FACTORY_ABI, functionName: 'delegates', args: [path[i] as `0x${string}`, path[i + 1] as `0x${string}`] },
  ])
  const results: readonly CallResult[] = await ctx.publicClient.multicall({
    contracts,
    allowFailure: true,
    multicallAddress: ctx.chain.multicall3,
    batchSize: 0,
  })

  return pairs.map((pair, i) => {
    const reservesResult = results[i * 3]
    const token0Result = results[i * 3 + 1]
    const delegatesResult = results[i * 3 + 2]
    if (reservesResult?.status !== 'success' || token0Result?.status !== 'success') {
      throw new SnfError('NO_ROUTE', 'Could not read reserves for a hop of the resolved path', { details: { pair } })
    }
    const [reserve0, reserve1] = reservesResult.result as readonly [bigint, bigint, number]
    const fromIsToken0 = (path[i] as `0x${string}`).toLowerCase() === (token0Result.result as `0x${string}`).toLowerCase()
    const [reserveIn, reserveOut] = fromIsToken0 ? [reserve0, reserve1] : [reserve1, reserve0]
    const isDelegated = delegatesResult?.status === 'success' && delegatesResult.result === true
    // `Factory.delegates` is compiled per chain into that chain's own `Delegation.sol`
    // (registry.ts records the source) — a hardcoded delegate constant would be wrong
    // on any chain whose upstream DEX differs.
    const netFeeBps = isDelegated ? ctx.chain.delegateNetFee : ctx.chain.poolNetFee
    return { reserveIn, reserveOut, netFee: BigInt(netFeeBps), netFeeBps }
  })
}

/** Router's own plain `getAmountsOut`/`getAmountsIn` for the SAME path — the
 * cross-check this module's local curve reconstruction must exactly equal. */
async function routerAmounts(
  ctx: SnfClientContext,
  path: readonly `0x${string}`[],
  amount: bigint,
  direction: 'out' | 'in',
): Promise<readonly bigint[]> {
  const routerAbi = ctx.chain.routerVariant === 'native-erc20' ? ROUTER_NATIVE_ERC20_ABI : ROUTER02_COLLECTION_ABI
  const functionName = direction === 'out' ? 'getAmountsOut' : 'getAmountsIn'
  const results = await ctx.publicClient.multicall({
    contracts: [{ address: ctx.chain.router02, abi: routerAbi, functionName, args: [amount, path] }],
    allowFailure: true,
    multicallAddress: ctx.chain.multicall3,
    batchSize: 0,
  })
  const result = results[0]
  if (result?.status !== 'success') {
    throw new SnfError('NO_ROUTE', `Could not read Router ${functionName} for the resolved path`, {
      details: { path },
    })
  }
  return result.result
}

function assertAmountsMatch(local: readonly bigint[], router: readonly bigint[]): void {
  const matches = local.length === router.length && local.every((v, i) => v === router[i])
  if (matches) return
  throw new SnfError('QUOTE_RECONCILIATION_FAILED', 'Local curve amounts did not match the Router on-chain answer', {
    details: { local, router },
  })
}

/** Nominal (no-fee, no-curve) receive, chained through every hop's own spot ratio —
 * the multi-hop composition `singlePoolPriceImpact`'s header names. */
function chainedNominal(amountIn: bigint, hops: readonly HopContext[]): bigint {
  return hops.reduce((acc, hop) => (hop.reserveIn > 0n ? (acc * hop.reserveOut) / hop.reserveIn : 0n), amountIn)
}

export async function quoteSwap(ctx: SnfClientContext, args: QuoteSwapArgs): Promise<Quote> {
  assertChainMatch(args.chainId, ctx.chain.chainId)
  const quoteToken = ctx.chain.quoteToken
  validateArgs(args, quoteToken)

  const inAddr = normalizeAddr(args.tokenIn, quoteToken)
  const outAddr = normalizeAddr(args.tokenOut, quoteToken)
  const resolved = await resolvePath(ctx, inAddr, outAddr, quoteToken)
  if (!resolved) {
    throw new SnfError('NO_ROUTE', 'No pair exists for this token pair, directly or via the quote token', { details: { tokenIn: args.tokenIn, tokenOut: args.tokenOut, viablePayTokens: [] } })
  }
  if (args.directOnly === true && !resolved.directAvailable) {
    const { decimals, symbol } = await resolveTokenMeta(ctx, quoteToken)
    throw new SnfError('NO_ROUTE', 'No direct pair exists and directOnly forbids routing through an intermediate hop', {
      details: {
        reason: 'direct-only',
        viablePayTokens: [{ address: quoteToken, symbol, decimals, isNative: true }],
      },
    })
  }

  const { path, pairs } = resolved
  const hops = await loadHops(ctx, path, pairs)
  const netFees = hops.map((h) => h.netFee)
  const reserves = hops.map((h) => [h.reserveIn, h.reserveOut] as const)
  const [inMeta, outMeta] = await Promise.all([resolveTokenMeta(ctx, inAddr), resolveTokenMeta(ctx, outAddr)])

  let amountInValue: bigint
  let amountOutValue: bigint
  if (args.amountIn !== undefined) {
    amountInValue = args.amountIn
    const local = getAmountsOutChain(amountInValue, reserves, netFees)
    if (local === undefined) throw new SnfError('NO_ROUTE', 'This path cannot fill the requested amountIn', { details: { path } })
    assertAmountsMatch(local, await routerAmounts(ctx, path, amountInValue, 'out'))
    amountOutValue = local[local.length - 1] as bigint
  } else {
    amountOutValue = args.amountOut as bigint
    const local = getAmountsInChain(amountOutValue, reserves, netFees)
    if (local === undefined) throw new SnfError('NO_ROUTE', 'This path cannot deliver the requested amountOut', { details: { path } })
    assertAmountsMatch(local, await routerAmounts(ctx, path, amountOutValue, 'in'))
    amountInValue = local[0] as bigint
  }

  // Single hop: singlePoolPriceImpact (Task 1) — that one pool's spot ratio is the
  // nominal baseline. Multi-hop: chainedNominal composes each hop's own spot ratio
  // (no fee, no curve) in sequence, then the same crossPoolPriceImpact clamp applies.
  const priceImpact =
    hops.length === 1 && hops[0]
      ? singlePoolPriceImpact({
          reserveIn: hops[0].reserveIn,
          reserveOut: hops[0].reserveOut,
          amountIn: amountInValue,
          actualOut: amountOutValue,
        })
      : crossPoolPriceImpact({ nominalReceive: chainedNominal(amountInValue, hops), actualReceive: amountOutValue })

  const poolBps = 10_000 - (hops[0]?.netFeeBps ?? 10_000)
  const fees: FeeBreakdown = {
    pool: { bps: poolBps, note: 'included in curve' },
    marketplace: { ...toQuoteAmount(ctx.chain.chainId, 0n), bps: 0 },
    royalty: { ...toQuoteAmount(ctx.chain.chainId, 0n), bps: 0, capApplied: false },
  }

  const amountIn: Amount = inAddr.toLowerCase() === quoteToken.toLowerCase() ? toQuoteAmount(ctx.chain.chainId, amountInValue) : toAmount(amountInValue, inMeta.decimals, inMeta.symbol)
  const amountOut: Amount = outAddr.toLowerCase() === quoteToken.toLowerCase() ? toQuoteAmount(ctx.chain.chainId, amountOutValue) : toAmount(amountOutValue, outMeta.decimals, outMeta.symbol)
  const leg: QuoteLeg = {
    pair: pairs[0] as `0x${string}`,
    count: 0,
    amount: amountOut,
    path,
    feeBps: poolBps,
    kind: args.tokenIn === null || args.tokenOut === null ? 'native' : 'erc20',
    side: 'sell',
  }
  return {
    side: 'swap',
    chainId: ctx.chain.chainId,
    legs: [leg],
    fees,
    amountIn,
    amountOut,
    amountSpecified: args.amountIn !== undefined ? 'in' : 'out',
    priceImpact,
    deliverable: 1,
    bestEffort: false,
    expiresAt: new Date(Date.now() + QUOTE_TTL_MS).toISOString(),
    reconciled: true,
  }
}
