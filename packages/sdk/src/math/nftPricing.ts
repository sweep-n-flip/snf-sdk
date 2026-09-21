import { notImplemented } from '../internal/stub'
import type { LadderResult } from '../types/quote.types'

/** Pool-side reserves as read from `Pair.getReserves()`, already resolved to the
 * wrapper/base side (never assume token0/token1). */
export interface PoolReserves {
  readonly base: bigint
  readonly wnft: bigint
}

/**
 * Offline, float-labelled unit-price ladder for `n` NFTs from `reserves` — R12.
 * `kind: 'estimate'` on the result marks it as NEVER on-chain-authoritative; a static
 * test in `build/` asserts no builder module imports this function.
 *
 * @gsd-stub — implemented by plan 06. Source analog: snf-client/src/lib/nftPricing.ts
 * (`buildNFTPriceLadder`).
 */
export function estimateLadder(reserves: PoolReserves, n: number): LadderResult {
  void reserves
  void n
  return notImplemented('estimateLadder', '06')
}

/**
 * On-chain-authoritative bigint cost to buy `n` NFTs from `reserves`, mirroring the
 * Router's own AMM curve exactly (`SNF_NFT_NET_FEE = 9800`).
 *
 * @gsd-stub — implemented by plan 06. Source analog: snf-client/src/lib/nftPricing.ts
 * (`nftBuyCost`).
 */
export function nftBuyCost(reserves: PoolReserves, n: number): bigint {
  void reserves
  void n
  return notImplemented('nftBuyCost', '06')
}

/**
 * On-chain-authoritative bigint proceeds from selling `n` NFTs into `reserves`,
 * mirroring the Router's own AMM curve exactly.
 *
 * @gsd-stub — implemented by plan 06. Source analog: snf-client/src/lib/nftPricing.ts
 * (`nftSellProceeds`).
 */
export function nftSellProceeds(reserves: PoolReserves, n: number): bigint {
  void reserves
  void n
  return notImplemented('nftSellProceeds', '06')
}
