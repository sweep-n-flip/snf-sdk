import { useQuery } from '@tanstack/react-query'
import type { PoolInventory } from '@sweepnflip/sdk'
import { useSnfContext } from '../context'
import { snfQueryKeys } from '../queryKeys'
import { withSnfError, type SnfQueryOptions, type SnfQueryResult } from './shared'

export type UseSnfPoolInventoryOptions = SnfQueryOptions<PoolInventory>
export type UseSnfPoolInventoryResult = SnfQueryResult<PoolInventory>

/**
 * Wraps `SnfClient.poolInventory` — a pool's candidate tokenIds and buyable
 * ceiling. `staleTime` 15 s and a 5 s `refetchInterval` (the reserve cadence this
 * plan's own truth mandates as the default — mirrors `snf-client`'s
 * `usePoolLiveData` 10 s reserve-polling pattern, tightened to 5 s per this plan's
 * literal instruction), both overridable via `options`. `enabled` only once `pair` is
 * set — a pool's reserves are meaningless without knowing which pool.
 */
export function useSnfPoolInventory(
  pair: `0x${string}` | undefined,
  options?: UseSnfPoolInventoryOptions,
): UseSnfPoolInventoryResult {
  const { client, chainId, txInvalidationVersion } = useSnfContext()

  const result = useQuery({
    staleTime: 15_000,
    refetchInterval: 5_000,
    ...options,
    queryKey: snfQueryKeys.inventory(chainId, txInvalidationVersion, pair ?? ''),
    queryFn: () => client.poolInventory(pair as `0x${string}`),
    enabled: pair !== undefined && (options?.enabled ?? true),
  })

  return withSnfError(client, result)
}
