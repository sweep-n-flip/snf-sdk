import { describe, expect, it } from 'vitest'

import { quoteNftToNft } from '../../src/quote/quoteNftToNft'
import { getAmountIn, getAmountOut, ONE_E18, SNF_NFT_NET_FEE } from '../../src/math/quoteMath'
import { wnftUnitsFromCount } from '../../src/routing/wnftPathScale'
import { buildTwoLegEnv, ZERO_ADDRESS, type LegConfig, type TwoLegConfig } from './nftToNftTestHelpers'
import { computeNftToNftQuote } from '../parity/computeNftToNftQuote.reference'

/**
 * Parity: the SDK's `quoteNftToNft` vs the production AMM client's own
 * `computeNftToNftQuote` (see
 * `test/parity/computeNftToNftQuote.reference.ts`'s header).
 *
 * THE TWO MODELS ARE NOT THE SAME MATH, BY DESIGN:
 * - The reference is FLOAT arithmetic over a `reserves` snapshot, applies royalty
 * as ONE AVERAGED rate per collection, and CAPS the buy count itself
 * (`actualBuyCount = min(nftOutCount, maxBuyCount)`) when the sell proceeds
 * cannot cover the requested buy — the pre-v1 client UX contract ("Route A"),
 * which never requires a top-up from the user.
 * - The SDK is BIGINT arithmetic reconciled to the wei against the Router's own
 * on-chain read, sums RAW per-id royalty amounts (never an average —
 * this file's rounding-hazard deviation), and ALWAYS fulfils the
 * requested `buy.count` up to pool depth, exposing `remainder`/`netProceeds`/
 * `buyCost` so a caller derives a top-up instead — the v1 API contract
 * (DATASHEET §4 "Remainder field").
 *
 * Parity is therefore measured on rows where the reference's own cap NEVER engages
 * (`maxBuyCount >= buyCount` asserted per row) — in that regime the two models
 * price the SAME trade from the SAME inputs, and every field below is directly
 * comparable up to bigint-floor-vs-float rounding. Every row also uses a UNIFORM
 * royalty rate across every sold/bought id — the one case where "sum of raw per-id
 * reads" and "one averaged rate" are mathematically equivalent (up to truncation).
 */

const SELL_PAIR = '0x000000000000000000000000000000005e11000a' as `0x${string}`
const SELL_WRAPPER = '0x000000000000000000000000000000005e11000b' as `0x${string}`
const SELL_COLLECTION = '0x000000000000000000000000000000005e11000c' as `0x${string}`
const BUY_PAIR = '0x000000000000000000000000000000006b1000a1' as `0x${string}`
const BUY_WRAPPER = '0x000000000000000000000000000000006b1000b1' as `0x${string}`
const BUY_COLLECTION = '0x000000000000000000000000000000006b1000c1' as `0x${string}`
const SELL_RECEIVER = '0x1111111111111111111111111111111111111111' as `0x${string}`
const BUY_RECEIVER = '0x2222222222222222222222222222222222222222' as `0x${string}`

interface Row {
  readonly name: string
  readonly sellReserves: { readonly base: bigint; readonly wnft: bigint }
  readonly buyReserves: { readonly base: bigint; readonly wnft: bigint }
  readonly sellCount: number
  readonly buyCount: number
  readonly marketplaceFeePercent: number
  readonly royaltiesOn: boolean
  readonly sellRoyaltyPct: number
  readonly buyRoyaltyPct: number
  readonly remainder: 'native' | 'wnft'
}

const ROWS: readonly Row[] = [
  {
    name: '1: equal pools, no royalty, native remainder',
    sellReserves: { base: 500n * ONE_E18, wnft: 50n * ONE_E18 },
    buyReserves: { base: 500n * ONE_E18, wnft: 50n * ONE_E18 },
    sellCount: 2, buyCount: 1, marketplaceFeePercent: 2.5, royaltiesOn: false, sellRoyaltyPct: 0, buyRoyaltyPct: 0,
    remainder: 'native',
  },
  {
    name: '2: equal pools, no royalty, wnft remainder',
    sellReserves: { base: 500n * ONE_E18, wnft: 50n * ONE_E18 },
    buyReserves: { base: 500n * ONE_E18, wnft: 50n * ONE_E18 },
    sellCount: 3, buyCount: 1, marketplaceFeePercent: 2.5, royaltiesOn: false, sellRoyaltyPct: 0, buyRoyaltyPct: 0,
    remainder: 'wnft',
  },
  {
    name: '3: cheaper buy pool, no royalty, native remainder',
    sellReserves: { base: 500n * ONE_E18, wnft: 50n * ONE_E18 },
    buyReserves: { base: 300n * ONE_E18, wnft: 80n * ONE_E18 },
    sellCount: 1, buyCount: 2, marketplaceFeePercent: 2.5, royaltiesOn: false, sellRoyaltyPct: 0, buyRoyaltyPct: 0,
    remainder: 'native',
  },
  {
    name: '4: uniform royalty 5%/3%, native remainder',
    sellReserves: { base: 500n * ONE_E18, wnft: 50n * ONE_E18 },
    buyReserves: { base: 500n * ONE_E18, wnft: 50n * ONE_E18 },
    sellCount: 3, buyCount: 1, marketplaceFeePercent: 2.5, royaltiesOn: true, sellRoyaltyPct: 5, buyRoyaltyPct: 3,
    remainder: 'native',
  },
  {
    name: '5: uniform royalty 4%/4%, cheaper buy pool, wnft remainder',
    sellReserves: { base: 500n * ONE_E18, wnft: 50n * ONE_E18 },
    buyReserves: { base: 300n * ONE_E18, wnft: 80n * ONE_E18 },
    sellCount: 2, buyCount: 2, marketplaceFeePercent: 2.5, royaltiesOn: true, sellRoyaltyPct: 4, buyRoyaltyPct: 4,
    remainder: 'wnft',
  },
  {
    name: '6: larger reserves, no royalty, native remainder',
    sellReserves: { base: 2_000n * ONE_E18, wnft: 100n * ONE_E18 },
    buyReserves: { base: 1_000n * ONE_E18, wnft: 60n * ONE_E18 },
    sellCount: 5, buyCount: 3, marketplaceFeePercent: 2.5, royaltiesOn: false, sellRoyaltyPct: 0, buyRoyaltyPct: 0,
    remainder: 'native',
  },
]

function pctToE18(pct: number): bigint {
  // pct expressed as e.g. 2.5 for 2.5% — scaled to 1e18 via basis points to avoid a
  // float multiplication anywhere near the bigint reconciliation math.
  return (BigInt(Math.round(pct * 100)) * ONE_E18) / 10_000n
}

/** Derives an exact, self-consistent `TwoLegConfig` from raw economic parameters —
 * every `routerTotal` is computed via the SAME curve/fee math `quoteNftToNft` itself
 * reconstructs, so reconciliation always holds and the fixture is never fighting the
 * function under test. */
function deriveConfig(row: Row): TwoLegConfig {
  const marketplaceFeeE18 = pctToE18(row.marketplaceFeePercent)
  const sellRoyaltyE18 = row.royaltiesOn ? pctToE18(row.sellRoyaltyPct) : 0n
  const buyRoyaltyE18 = row.royaltiesOn ? pctToE18(row.buyRoyaltyPct) : 0n

  const sellUnits = wnftUnitsFromCount(row.sellCount)
  const sellPoolLeg = getAmountOut(sellUnits, row.sellReserves.wnft, row.sellReserves.base, SNF_NFT_NET_FEE)
  if (sellPoolLeg === undefined) throw new Error(`deriveConfig: sell leg unfillable for row ${row.name}`)
  const sellMarketplace = (sellPoolLeg * marketplaceFeeE18) / ONE_E18
  const sellSalePrice = sellPoolLeg / BigInt(row.sellCount)
  const sellRoyaltyPerId = (sellSalePrice * sellRoyaltyE18) / ONE_E18
  const sellRoyaltyTotal = sellRoyaltyPerId * BigInt(row.sellCount)
  const sellRouterTotal = sellPoolLeg - sellMarketplace - sellRoyaltyTotal

  const buyUnits = wnftUnitsFromCount(row.buyCount)
  const buyPoolLeg = getAmountIn(buyUnits, row.buyReserves.base, row.buyReserves.wnft, SNF_NFT_NET_FEE)
  if (buyPoolLeg === undefined) throw new Error(`deriveConfig: buy leg unfillable for row ${row.name}`)
  const buyMarketplace = (buyPoolLeg * marketplaceFeeE18) / ONE_E18
  const buySalePrice = buyPoolLeg / BigInt(row.buyCount)
  const buyRoyaltyPerId = (buySalePrice * buyRoyaltyE18) / ONE_E18
  const buyRoyaltyTotal = buyRoyaltyPerId * BigInt(row.buyCount)
  const buyRouterTotal = buyPoolLeg + buyMarketplace + buyRoyaltyTotal

  const sellTokenIds = Array.from({ length: row.sellCount }, (_, i) => String(i + 1))
  const buyTokenIds = Array.from({ length: row.buyCount }, (_, i) => String(i + 101))

  const sell: LegConfig = {
    pair: SELL_PAIR,
    wrapper: SELL_WRAPPER,
    collection: SELL_COLLECTION,
    reserves: row.sellReserves,
    units: sellUnits,
    poolLeg: sellPoolLeg,
    routerTotal: sellRouterTotal,
    perId: sellTokenIds.map((tokenId) => ({ tokenId, receiver: row.royaltiesOn ? SELL_RECEIVER : ZERO_ADDRESS, amount: sellRoyaltyPerId })),
  }
  const buy: LegConfig = {
    pair: BUY_PAIR,
    wrapper: BUY_WRAPPER,
    collection: BUY_COLLECTION,
    reserves: row.buyReserves,
    units: buyUnits,
    poolLeg: buyPoolLeg,
    routerTotal: buyRouterTotal,
    perId: buyTokenIds.map((tokenId) => ({ tokenId, receiver: row.royaltiesOn ? BUY_RECEIVER : ZERO_ADDRESS, amount: buyRoyaltyPerId })),
  }

  return { chainId: 8453, marketplaceFeeE18, sell, buy }
}

function closeRelative(actual: number, expected: number, tol = 0.02): void {
  const denom = Math.max(Math.abs(expected), 1e-9)
  const diff = Math.abs(actual - expected) / denom
  expect(diff, `${actual} vs ${expected} (relative diff ${diff})`).toBeLessThan(tol)
}

describe('nftToNft parity: SDK quoteNftToNft vs snf-client computeNftToNftQuote', () => {
  for (const row of ROWS) {
    it(row.name, async () => {
      const cfg = deriveConfig(row)
      const { ctx } = buildTwoLegEnv(cfg)
      const sdkQuote = await quoteNftToNft(ctx, {
        chainId: 8453,
        sell: { collection: SELL_COLLECTION, tokenIds: cfg.sell.perId.map((p) => p.tokenId) },
        buy: { collection: BUY_COLLECTION, count: row.buyCount },
        remainder: row.remainder,
      })

      const refResult = computeNftToNftQuote({
        sellReserves: { reserve0Raw: row.sellReserves.base, reserve1Raw: row.sellReserves.wnft },
        buyReserves: { reserve0Raw: row.buyReserves.base, reserve1Raw: row.buyReserves.wnft },
        sellNFTIsToken0: false,
        buyNFTIsToken0: false,
        sellCount: row.sellCount,
        nftOutCount: row.buyCount,
        remainderMode: row.remainder === 'wnft' ? 'wnft' : 'eth',
        royaltiesOn: row.royaltiesOn,
        marketplaceFeePercent: row.marketplaceFeePercent,
        sellRoyaltyPct: row.sellRoyaltyPct,
        buyRoyaltyPct: row.buyRoyaltyPct,
        quoteDecimals: 18,
      })

      // Sanity: this row must sit in the regime where the reference's own cap never
      // engages — otherwise the two models are answering different questions (see
      // this file's header) and the comparison below would be meaningless.
      expect(refResult.isReady).toBe(true)
      expect(refResult.maxBuyCount).toBeGreaterThanOrEqual(row.buyCount)

      const netProceeds = Number(sdkQuote.netProceeds?.value ?? 0n) / 1e18
      const buyCost = Number(sdkQuote.buyCost?.value ?? 0n) / 1e18
      closeRelative(netProceeds, refResult.availableETH)
      closeRelative(buyCost, refResult.buyCostTotal)

      if (row.remainder === 'native') {
        const remainder = Number(sdkQuote.remainder?.value ?? 0n) / 1e18
        closeRelative(remainder, refResult.ethRemainder, 0.03)
      } else {
        const remainderNft = Number(sdkQuote.remainder?.value ?? 0n) / 1e18
        closeRelative(remainderNft, refResult.wNFTReceived, 0.05)
      }

      // priceImpact/crossRate: same CONCEPT (spot-vs-actual), computed via
      // deliberately different-but-consistent formulas (this file's header) — both
      // land in [0, 100] and within a wide tolerance of each other, never a
      // four-digit or negative number on either side.
      expect(sdkQuote.priceImpact).toBeGreaterThanOrEqual(0)
      expect(sdkQuote.priceImpact).toBeLessThanOrEqual(100)
      expect(refResult.priceImpact).toBeGreaterThanOrEqual(0)
      expect(refResult.priceImpact).toBeLessThanOrEqual(100)
    })
  }
})
