import { PoolStatsCeiling } from './PoolStatsCeiling'
import { PoolStatsPrice } from './PoolStatsPrice'
import { PoolStatsReserves } from './PoolStatsReserves'
import { PoolStatsRoot } from './PoolStatsRoot'

/**
 * `SnfPoolStats` — the compound export. `Root` orchestrates a single
 * collection's pool/inventory/one-unit price; `Price`/`Reserves`/`Ceiling` are the
 * leaf display Parts, each reading `usePoolStatsContext()` and never calling a
 * `useSnf*` hook directly.
 */
export const SnfPoolStats = {
  Root: PoolStatsRoot,
  Price: PoolStatsPrice,
  Reserves: PoolStatsReserves,
  Ceiling: PoolStatsCeiling,
}

export type { PoolStatsContextValue, PoolStatsPartProps, SnfPoolStatsRootProps } from './PoolStats.types'
