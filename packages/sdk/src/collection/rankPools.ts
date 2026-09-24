import type { PoolRef } from '../types/collection.types'

/**
 * `rankPoolsByLiquidity` — orders a collection's pools by liquidity, native base
 * first on a tie (Edge `ordering`). Pure, no I/O: `resolveCollection.ts` supplies
 * whatever `reserveUSD` it managed to read from the subgraph (which may be partial,
 * or absent entirely when the index is degraded — see that module's enrichment
 * step); this function never fetches anything itself.
 */

/**
 * `reserveUSD`, keyed by lowercased pair address. When every pool in the input has an
 * entry here, ranking uses it (the subgraph's own USD-denominated reserve). When ANY
 * pool is missing an entry, ranking falls back to the base-side reserve normalised to
 * 18 decimals for ALL pools uniformly — mixing a USD figure for one pool against a
 * raw reserve for another would not be a meaningful comparison.
 */
export type ReserveUsdByPair = ReadonlyMap<string, number>

/** Scales `pool.reserves.base` to 18 decimals so pools with different-decimal base
 * tokens (e.g. Arc's 6-decimal USDC quote vs. a WETH9 18-decimal quote) compare
 * fairly without any float/price lookup. */
function normalizedBaseReserve(pool: PoolRef): bigint {
  const scale = 18 - pool.baseToken.decimals
  if (scale <= 0) return pool.reserves.base / 10n ** BigInt(-scale)
  return pool.reserves.base * 10n ** BigInt(scale)
}

function compareByNormalizedReserve(a: PoolRef, b: PoolRef): number {
  const na = normalizedBaseReserve(a)
  const nb = normalizedBaseReserve(b)
  if (nb > na) return 1
  if (nb < na) return -1
  return 0
}

function compareNativeFirst(a: PoolRef, b: PoolRef): number {
  if (a.isNative === b.isNative) return 0
  return a.isNative ? -1 : 1
}

export function rankPoolsByLiquidity(
  pools: readonly PoolRef[],
  reserveUSD?: ReserveUsdByPair,
): readonly PoolRef[] {
  const allHaveUsd = reserveUSD !== undefined && pools.every((p) => reserveUSD.has(p.pair.toLowerCase()))

  return [...pools].sort((a, b) => {
    if (allHaveUsd && reserveUSD) {
      const usdA = reserveUSD.get(a.pair.toLowerCase()) ?? 0
      const usdB = reserveUSD.get(b.pair.toLowerCase()) ?? 0
      if (usdB !== usdA) return usdB - usdA
    } else {
      const byReserve = compareByNormalizedReserve(a, b)
      if (byReserve !== 0) return byReserve
    }
    return compareNativeFirst(a, b)
  })
}
