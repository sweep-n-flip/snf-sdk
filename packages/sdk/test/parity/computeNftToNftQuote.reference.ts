/**
 * VERBATIM copy of the production AMM client's NFT×NFT quote math, for the parity
 * test (`test/quote/nftToNft.parity.test.ts`). Copied rather than imported directly
 * because the production client is a separate git repository outside this package's
 * `tsconfig.json` `rootDir` (`packages/sdk/tsconfig.json`'s `include: ["src",
 * "test"]`) — importing it directly would break `tsc --noEmit` for this package
 * (this package's own documented fallback for that case, Task 2).
 *
 * Source: the production AMM client's own `computeNftToNftQuote` (the whole
 * function plus its `ZERO` sentinel) and the four pure helpers it calls from that
 * client's own NFT-pricing module (`nftBuyCost`, `nftSellProceeds`,
 * `applyRoyaltyBuy`, `applyRoyaltySell`, `SNF_NFT_NET_FEE`, `SNF_NFT_FEE_DENOM`),
 * inlined here so this fixture has no dependency on any other file from that client.
 *
 * Copied at a fixed commit of the production client (2026-09-21).
 * If the production client's `computeNftToNftQuote` changes, this fixture drifts
 * silently until someone re-diffs against that commit — recorded here so a future
 * audit knows exactly what to re-diff against.
 *
 * NOT byte-identical to the SDK's own `quoteNftToNft` philosophy: this reference is
 * FLOAT arithmetic over a point-in-time `reserves` snapshot with a single AVERAGED
 * royalty rate per collection, never reconciled against a live on-chain read. The
 * SDK's `quoteNftToNft` is bigint arithmetic reconciled to the wei against the
 * Router's own on-chain answer, summing RAW per-id royalty reads rather than
 * applying one flat rate (see this file's rounding-hazard deviation).
 * The parity test therefore compares the two models with `toBeCloseTo` tolerance on
 * a UNIFORM-royalty-rate fixture (every tokenId sharing one rate), where the two
 * models are mathematically equivalent up to floor-vs-float rounding — see that
 * test file's own header for the full reasoning.
 */

const SNF_NFT_NET_FEE = 9800
const SNF_NFT_FEE_DENOM = 10000

function nftBuyCost(reserveETH: number, reserveNFT: number, n: number): number {
  if (n <= 0 || n >= reserveNFT) return Infinity
  return (reserveETH * n * SNF_NFT_FEE_DENOM) / ((reserveNFT - n) * SNF_NFT_NET_FEE) + 1e-18
}

function nftSellProceeds(reserveETH: number, reserveNFT: number, n: number): number {
  if (n <= 0) return 0
  return (reserveETH * n * SNF_NFT_NET_FEE) / (reserveNFT * SNF_NFT_FEE_DENOM + n * SNF_NFT_NET_FEE)
}

function applyRoyaltyBuy(cost: number, royaltyPercent: number, applied: boolean, marketplaceFeePercent: number): number {
  const totalFeePercent = marketplaceFeePercent + (applied ? royaltyPercent : 0)
  return cost * (1 + totalFeePercent / 100)
}

function applyRoyaltySell(proceeds: number, royaltyPercent: number, applied: boolean, marketplaceFeePercent: number): number {
  const totalFeePercent = marketplaceFeePercent + (applied ? royaltyPercent : 0)
  return proceeds * (1 - totalFeePercent / 100)
}

export interface ReferenceReserves {
  reserve0Raw: bigint
  reserve1Raw: bigint
}

export interface ComputeNftToNftQuoteArgs {
  sellReserves: ReferenceReserves | undefined
  buyReserves: ReferenceReserves | undefined
  sellNFTIsToken0: boolean
  buyNFTIsToken0: boolean
  sellCount: number
  nftOutCount: number
  remainderMode: 'wnft' | 'eth' | 'all-wnft'
  royaltiesOn: boolean
  marketplaceFeePercent: number
  sellRoyaltyPct: number
  buyRoyaltyPct: number
  quoteDecimals: number
}

export interface NftToNftQuote {
  availableETH: number
  buyCostTotal: number
  buyCostRaw: number
  wNFTReceived: number
  ethRemainder: number
  allWNFTAmount: number
  sellRoyaltyETH: number
  buyRoyaltyETH: number
  sellRoyaltyPct: number
  buyRoyaltyPct: number
  priceImpact: number
  crossRate: number
  maxBuyCount: number
  isReady: boolean
}

export const ZERO: NftToNftQuote = Object.freeze({
  availableETH: 0, buyCostTotal: 0, buyCostRaw: 0,
  wNFTReceived: 0, ethRemainder: 0, allWNFTAmount: 0,
  sellRoyaltyETH: 0, buyRoyaltyETH: 0,
  sellRoyaltyPct: 0, buyRoyaltyPct: 0,
  priceImpact: 0, crossRate: 0, maxBuyCount: 0,
  isReady: false,
})

export function computeNftToNftQuote({
  sellReserves,
  buyReserves,
  sellNFTIsToken0,
  buyNFTIsToken0,
  sellCount,
  nftOutCount,
  remainderMode,
  royaltiesOn,
  marketplaceFeePercent,
  sellRoyaltyPct,
  buyRoyaltyPct,
  quoteDecimals,
}: ComputeNftToNftQuoteArgs): NftToNftQuote {
  if (sellCount <= 0 || !sellReserves || !buyReserves) return ZERO

  const quoteScale = 10 ** quoteDecimals
  const nftScale = 1e18

  const sellReserveETH = sellNFTIsToken0
    ? Number(sellReserves.reserve1Raw) / quoteScale
    : Number(sellReserves.reserve0Raw) / quoteScale
  const sellReserveNFT = sellNFTIsToken0
    ? Number(sellReserves.reserve0Raw) / nftScale
    : Number(sellReserves.reserve1Raw) / nftScale

  const buyReserveETH = buyNFTIsToken0
    ? Number(buyReserves.reserve1Raw) / quoteScale
    : Number(buyReserves.reserve0Raw) / quoteScale
  const buyReserveNFT = buyNFTIsToken0
    ? Number(buyReserves.reserve0Raw) / nftScale
    : Number(buyReserves.reserve1Raw) / nftScale

  if (sellReserveETH <= 0 || sellReserveNFT <= 0 || buyReserveETH <= 0 || buyReserveNFT <= 0) return ZERO

  const rawSellProceeds = nftSellProceeds(sellReserveETH, sellReserveNFT, sellCount)
  const availableETH = applyRoyaltySell(rawSellProceeds, sellRoyaltyPct, royaltiesOn, marketplaceFeePercent)
  const sellRoyaltyETH = royaltiesOn ? rawSellProceeds * (sellRoyaltyPct / 100) : 0

  let maxBuyCount = 0
  for (let n = 1; n <= Math.floor(buyReserveNFT) - 1; n++) {
    const costRaw = nftBuyCost(buyReserveETH, buyReserveNFT, n)
    if (!isFinite(costRaw)) break
    const costFull = applyRoyaltyBuy(costRaw, buyRoyaltyPct, royaltiesOn, marketplaceFeePercent)
    if (costFull <= availableETH) maxBuyCount = n
    else break
  }

  const actualBuyCount = Math.min(nftOutCount, maxBuyCount)

  let buyCostRaw = 0
  let buyCostTotal = 0
  let buyRoyaltyETH = 0
  if (actualBuyCount > 0) {
    buyCostRaw = nftBuyCost(buyReserveETH, buyReserveNFT, actualBuyCount)
    buyCostTotal = applyRoyaltyBuy(buyCostRaw, buyRoyaltyPct, royaltiesOn, marketplaceFeePercent)
    buyRoyaltyETH = royaltiesOn ? buyCostRaw * (buyRoyaltyPct / 100) : 0
  }

  const leftoverETH = availableETH - buyCostTotal
  const ethRemainder = leftoverETH

  const postBuyReserveETH = buyReserveETH + buyCostRaw
  const postBuyReserveNFT = buyReserveNFT - actualBuyCount

  const mktFeeNet = 1 - marketplaceFeePercent / 100
  const leftoverETHNet = leftoverETH > 0 ? leftoverETH * mktFeeNet : 0
  const wNFTReceived = leftoverETHNet > 0 && postBuyReserveETH > 0 && postBuyReserveNFT > 0
    ? (leftoverETHNet * SNF_NFT_NET_FEE * postBuyReserveNFT) / (postBuyReserveETH * SNF_NFT_FEE_DENOM + leftoverETHNet * SNF_NFT_NET_FEE)
    : 0

  const availableETHNet = availableETH > 0 ? availableETH * mktFeeNet : 0
  const allWNFTAmount = availableETHNet > 0 && buyReserveETH > 0 && buyReserveNFT > 0
    ? (availableETHNet * SNF_NFT_NET_FEE * buyReserveNFT) / (buyReserveETH * SNF_NFT_FEE_DENOM + availableETHNet * SNF_NFT_NET_FEE)
    : 0

  const totalOut = remainderMode === 'all-wnft'
    ? allWNFTAmount
    : (actualBuyCount + (remainderMode === 'wnft' ? wNFTReceived : 0))
  const crossRate = sellCount > 0 ? totalOut / sellCount : 0

  const spotSellPrice = sellReserveNFT > 0 ? sellReserveETH / sellReserveNFT : 0
  const spotBuyPrice = buyReserveNFT > 0 ? buyReserveETH / buyReserveNFT : 0
  const sellFeeMul = 1 - marketplaceFeePercent / 100 - (royaltiesOn ? sellRoyaltyPct / 100 : 0)
  const buyFeeMul = 1 + marketplaceFeePercent / 100 + (royaltiesOn ? buyRoyaltyPct / 100 : 0)
  const nominalSellPrice = spotSellPrice * Math.max(0, sellFeeMul)
  const nominalBuyPrice = spotBuyPrice * buyFeeMul
  const nominalReceiveCount = nominalBuyPrice > 0 ? (sellCount * nominalSellPrice) / nominalBuyPrice : 0
  const priceImpactRaw = nominalReceiveCount > 0 && totalOut > 0 ? (1 - totalOut / nominalReceiveCount) * 100 : 0
  const priceImpact = Math.max(0, Math.min(100, priceImpactRaw))

  return {
    availableETH,
    buyCostTotal,
    buyCostRaw,
    wNFTReceived,
    ethRemainder,
    allWNFTAmount,
    sellRoyaltyETH,
    buyRoyaltyETH,
    sellRoyaltyPct,
    buyRoyaltyPct,
    priceImpact,
    crossRate,
    maxBuyCount,
    isReady: true,
  }
}
