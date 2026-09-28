import { useQuery } from '@tanstack/react-query'
import type { WnftBalances } from '@sweepnflip/sdk'
import { useSnfContext } from '../context'
import { snfQueryKeys } from '../queryKeys'
import { withSnfError, type SnfQueryOptions, type SnfQueryResult } from './shared'

export type UseSnfWnftBalancesOptions = SnfQueryOptions<WnftBalances>
export type UseSnfWnftBalancesResult = SnfQueryResult<WnftBalances>

/**
 * Wraps `SnfClient.wnftBalances` — every wrapped-NFT balance this owner
 * holds for a collection with an SnF pool on this client's own chain, all
 * read at one block. These track on-chain wNFT balances, so this refreshes
 * every 30 s — the same cadence `useSnfPositions` uses (both overridable
 * via `options`). Describes only the one chain of the active `SnfProvider`;
 * a partner showing several chains mounts one provider per chain.
 * `enabled` only once `owner` is set.
 */
export function useSnfWnftBalances(
  owner: `0x${string}` | undefined,
  options?: UseSnfWnftBalancesOptions,
): UseSnfWnftBalancesResult {
  const { client, chainId, txInvalidationVersion } = useSnfContext()

  const result = useQuery({
    staleTime: 20_000,
    refetchInterval: 30_000,
    ...options,
    queryKey: snfQueryKeys.wnftBalances(chainId, txInvalidationVersion, owner ?? ''),
    queryFn: () => client.wnftBalances(owner as `0x${string}`),
    enabled: owner !== undefined && (options?.enabled ?? true),
  })

  return withSnfError(client, result)
}
