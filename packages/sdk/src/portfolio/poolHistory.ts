import { getAddress, parseUnits } from 'viem'

import { assertParam } from '../errors'
import { toAmount, toPoolAmount } from '../format'
import type { TokenRef } from '../types/amount.types'
import type { SnfClientContext } from '../types/client.types'
import type { PoolHistory, PoolHistoryInterval, PoolHistoryOptions, PoolHistoryPoint } from '../types/portfolio.types'
import type { SubgraphHistoryPair, SubgraphHistoryToken, SubgraphPairBucket } from '../transport/subgraph.types'

/**
 * `poolHistory(pair, interval, opts?)` — a pool's own volume/reserve series, read
 * straight from the indexer's `PairDay`/`PairMonth` entities. This is the one
 * portfolio read this package cannot answer on-chain: history is a ledger of past
 * blocks, not a live state, so it — and only it — carries the indexer's own
 * freshness instead of a block this package just read itself.
 *
 * SPARSE, NOT EMPTY
 * A bucket exists only when a swap happened inside it — liquidity moved with no swap
 * shows up only at the NEXT swap's bucket. So a gap in `points` means no trading
 * activity, never a broken pool, and the reserves a bucket carries are the reserves
 * AT THAT BUCKET'S LAST SWAP, never a period-end snapshot. `[]` is a fully valid
 * answer (a pool with no swaps yet). A `'month'` bucket is 730 hours
 * (`bucketSeconds: 2_628_000`), not a calendar month — label it a 30-day bucket, not
 * "this month".
 *
 * COLUMNS ARE RE-ORIENTED, NEVER ASSUMED
 * The indexer's `volume0`/`volume1`/`reserve0`/`reserve1` are in `token0`/`token1`
 * order — the wrapper can sit on either side, so the base is NEVER simply `volume0`.
 * `discrete0` (the pair's own identity, re-read alongside every history request)
 * decides which column is which, the same rule every other portfolio read applies.
 *
 * EXACT UNITS, NO SUBGRAPH USD
 * Every BigDecimal string the indexer returns is parsed through a strict
 * `^\d+(\.\d+)?$` check and `parseUnits` at the exact side's own decimals — a
 * fraction longer than that many digits is truncated first rather than thrown on,
 * and anything that still fails the regex (an exponent, a negative sign, an empty or
 * non-numeric string) skips only that one bucket, never the whole call. The
 * indexer's own USD fields are never selected by the query this method calls and
 * never appear in its result.
 */

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const DECIMAL_STRING_RE = /^\d+(\.\d+)?$/
const MAX_LIMIT = 1000
const MAX_TOKEN_DECIMALS = 36
const DEFAULT_LIMIT: Record<PoolHistoryInterval, number> = { day: 90, month: 24 }
const BUCKET_SECONDS: Record<PoolHistoryInterval, 86_400 | 2_628_000> = { day: 86_400, month: 2_628_000 }

/** Truncates a longer-than-`decimals` fraction instead of letting `parseUnits`
 * reject it — the indexer never exceeded 18 digits live, but a longer one must not
 * fail the whole bucket. `decimals: 0` drops the fraction entirely. */
function truncateFraction(raw: string, decimals: number): string {
  const dot = raw.indexOf('.')
  if (dot === -1) return raw
  const whole = raw.slice(0, dot)
  const frac = raw.slice(dot + 1, dot + 1 + decimals)
  return frac.length > 0 ? `${whole}.${frac}` : whole
}

/** Parses one indexer BigDecimal string into an exact bigint at `decimals` —
 * `undefined` on anything that is not `^\d+(\.\d+)?$` (an exponent, a negative sign,
 * an empty string, `NaN`), never a thrown error. */
function parseDecimalString(raw: string, decimals: number): bigint | undefined {
  if (!DECIMAL_STRING_RE.test(raw)) return undefined
  try {
    return parseUnits(truncateFraction(raw, decimals), decimals)
  } catch {
    return undefined
  }
}

/** The base side's identity: the chain's own native token when the other side's id
 * equals `ctx.chain.quoteToken` (the registry always wins over whatever the indexer
 * claims for decimals there — Arc's native pool is the reference case), else the
 * indexer's own symbol/decimals, validated as an integer 0..36. `undefined` means
 * the pair fails the "this is an SnF NFT pool" gate. */
function resolveBaseToken(ctx: SnfClientContext, other: SubgraphHistoryToken): TokenRef | undefined {
  if (other.id.toLowerCase() === ctx.chain.quoteToken.toLowerCase()) {
    return { address: getAddress(other.id), symbol: ctx.chain.nativeSymbol, decimals: ctx.chain.quoteDecimals, isNative: true }
  }
  const decimals = Number(other.decimals)
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_TOKEN_DECIMALS) return undefined
  return { address: getAddress(other.id), symbol: other.symbol, decimals, isNative: false }
}

/** One bucket, oriented by `wrapperIsToken0` and parsed into exact units —
 * `undefined` (skip, never throw) when any of its numeric fields fails the strict
 * decimal-string check. */
function pointFromBucket(bucket: SubgraphPairBucket, wrapperIsToken0: boolean, baseToken: TokenRef): PoolHistoryPoint | undefined {
  const t = Number(bucket.t)
  if (!Number.isFinite(t)) return undefined

  const volumeBase = parseDecimalString(wrapperIsToken0 ? bucket.volume1 : bucket.volume0, baseToken.decimals)
  const volumeWnft = parseDecimalString(wrapperIsToken0 ? bucket.volume0 : bucket.volume1, 18)
  const reserveBase = parseDecimalString(wrapperIsToken0 ? bucket.reserve1 : bucket.reserve0, baseToken.decimals)
  const reserveWnft = parseDecimalString(wrapperIsToken0 ? bucket.reserve0 : bucket.reserve1, 18)
  const totalSupply = parseDecimalString(bucket.totalSupply, 18)
  if (
    volumeBase === undefined ||
    volumeWnft === undefined ||
    reserveBase === undefined ||
    reserveWnft === undefined ||
    totalSupply === undefined
  ) {
    return undefined
  }

  const txCount = Number(bucket.txCount)
  if (!Number.isFinite(txCount)) return undefined

  return {
    t,
    volumeBase: toPoolAmount(baseToken, volumeBase),
    volumeWnft: toAmount(volumeWnft, 18, 'wNFT'),
    reserveBase: toPoolAmount(baseToken, reserveBase),
    reserveWnft: toAmount(reserveWnft, 18, 'wNFT'),
    totalSupply,
    txCount,
  }
}

/** `pairData`'s own gate: it must exist, be flagged as an SnF NFT pool, and have
 * exactly one discrete side — never both, never neither. Shared shape with the other
 * portfolio reads' `not-an-snf-pair` rejection. */
function assertSnfPair(pairData: SubgraphHistoryPair | null, pair: `0x${string}`): asserts pairData is SubgraphHistoryPair {
  assertParam(
    pairData !== null && pairData.isNFTPool === true && pairData.discrete0 !== pairData.discrete1,
    'this pair is not an SnF NFT pool',
    { field: 'pair', value: pair, reason: 'not-an-snf-pair' },
  )
}

export async function poolHistory(
  ctx: SnfClientContext,
  pair: `0x${string}`,
  interval: PoolHistoryInterval,
  opts?: PoolHistoryOptions,
): Promise<PoolHistory> {
  assertParam(ADDRESS_RE.test(pair), 'pair must be a well-formed 0x address', { field: 'pair', value: pair })
  assertParam(interval === 'day' || interval === 'month', "interval must be 'day' or 'month'", {
    field: 'interval',
    value: interval,
  })
  const limit = opts?.limit ?? DEFAULT_LIMIT[interval]
  assertParam(Number.isInteger(limit) && limit >= 1 && limit <= MAX_LIMIT, `limit must be an integer between 1 and ${String(MAX_LIMIT)}`, {
    field: 'limit',
    value: limit,
    max: MAX_LIMIT,
  })

  const checksummedPair = getAddress(pair)
  const { data, asOfBlock, lagSeconds, stale } = await ctx.transport.pairHistory(checksummedPair, interval, limit)

  assertSnfPair(data.pair, checksummedPair)
  const wrapperIsToken0 = data.pair.discrete0
  const other = wrapperIsToken0 ? data.pair.token1 : data.pair.token0
  const baseToken = resolveBaseToken(ctx, other)
  assertParam(baseToken !== undefined, 'this pair is not an SnF NFT pool', {
    field: 'pair',
    value: checksummedPair,
    reason: 'not-an-snf-pair',
  })

  // The indexer returns buckets newest-first; the public contract is ascending.
  const points = data.buckets
    .map((bucket) => pointFromBucket(bucket, wrapperIsToken0, baseToken))
    .filter((point): point is PoolHistoryPoint => point !== undefined)
    .reverse()

  return {
    chainId: ctx.chain.chainId,
    pair: checksummedPair,
    interval,
    bucketSeconds: BUCKET_SECONDS[interval],
    baseToken,
    points,
    asOfBlock,
    lagSeconds,
    stale,
  }
}
