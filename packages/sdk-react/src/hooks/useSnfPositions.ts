import { useQuery } from '@tanstack/react-query'
import type { PortfolioPositions } from '@sweepnflip/sdk'
import { useSnfContext } from '../context'
import { snfQueryKeys } from '../queryKeys'
import { withSnfError, type SnfQueryOptions, type SnfQueryResult } from './shared'

export type UseSnfPositionsOptions = SnfQueryOptions<PortfolioPositions>
export type UseSnfPositionsResult = SnfQueryResult<PortfolioPositions>

/**
 * Wraps `SnfClient.positions` — every LP position this owner holds in this
 * client's own chain, all read at one block. These track on-chain LP
 * balances, so this refreshes every 30 s — the same cadence the reference
 * app's own LP scan uses (both overridable via `options`). Describes only
 * the one chain of the active `SnfProvider`; a partner showing several
 * chains mounts one provider (one client) per chain and loops over the
 * results — there is no cross-chain hook here. `enabled` only once `owner`
 * is set.
 */
export function useSnfPositions(
  owner: `0x${string}` | undefined,
  options?: UseSnfPositionsOptions,
): UseSnfPositionsResult {
  const { client, chainId, txInvalidationVersion } = useSnfContext()

  const result = useQuery({
    staleTime: 20_000,
    refetchInterval: 30_000,
    ...options,
    queryKey: snfQueryKeys.positions(chainId, txInvalidationVersion, owner ?? ''),
    queryFn: () => client.positions(owner as `0x${string}`),
    enabled: owner !== undefined && (options?.enabled ?? true),
  })

  return withSnfError(client, result)
}
