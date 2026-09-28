import { useQuery } from '@tanstack/react-query'
import type { PoolHistory, PoolHistoryInterval, PoolHistoryOptions } from '@sweepnflip/sdk'
import { useSnfContext } from '../context'
import { snfQueryKeys } from '../queryKeys'
import { withSnfError, type SnfQueryOptions, type SnfQueryResult } from './shared'

export type UseSnfPoolHistoryOptions = SnfQueryOptions<PoolHistory>
export type UseSnfPoolHistoryResult = SnfQueryResult<PoolHistory>

/**
 * Wraps `SnfClient.poolHistory` — a pool's own volume/reserve series,
 * bucketed by `interval`. This is cached 5 minutes in the core transport
 * itself, so this hook matches that cadence (`staleTime` 300 s) and carries
 * NO polling interval — a bucket changes at most once per swap, far slower
 * than any interval would be worth. `enabled` only once `pair` is set;
 * `interval` is always required, matching `SnfClient.poolHistory` itself.
 */
export function useSnfPoolHistory(
  pair: `0x${string}` | undefined,
  interval: PoolHistoryInterval,
  args?: PoolHistoryOptions,
  options?: UseSnfPoolHistoryOptions,
): UseSnfPoolHistoryResult {
  const { client, chainId, txInvalidationVersion } = useSnfContext()
  const limit = args?.limit ?? null

  const result = useQuery({
    staleTime: 300_000,
    ...options,
    queryKey: snfQueryKeys.poolHistory(chainId, txInvalidationVersion, pair ?? '', interval, limit),
    queryFn: () => client.poolHistory(pair as `0x${string}`, interval, args),
    enabled: pair !== undefined && (options?.enabled ?? true),
  })

  return withSnfError(client, result)
}
