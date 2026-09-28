import { useQuery } from '@tanstack/react-query'
import type { CollectionsHeld } from '@sweepnflip/sdk'
import { useSnfContext } from '../context'
import { snfQueryKeys } from '../queryKeys'
import { withSnfError, type SnfQueryOptions, type SnfQueryResult } from './shared'

export type UseSnfCollectionsHeldOptions = SnfQueryOptions<CollectionsHeld>
export type UseSnfCollectionsHeldResult = SnfQueryResult<CollectionsHeld>

/**
 * Wraps `SnfClient.collectionsHeld` — the NFT collections this owner holds,
 * through the partner's own `walletNfts` provider; `{ status: 'unavailable'
 * }` is a valid answer (no provider configured), not an error, and is
 * returned as data like any other result. This is answered by the
 * partner's own indexer, so it caches for 60 s and carries NO polling
 * interval — polling here would burn the partner's indexer quota, unlike
 * the on-chain balance hooks above. `enabled` only once `owner` is set.
 */
export function useSnfCollectionsHeld(
  owner: `0x${string}` | undefined,
  options?: UseSnfCollectionsHeldOptions,
): UseSnfCollectionsHeldResult {
  const { client, chainId, txInvalidationVersion } = useSnfContext()

  const result = useQuery({
    staleTime: 60_000,
    ...options,
    queryKey: snfQueryKeys.collectionsHeld(chainId, txInvalidationVersion, owner ?? ''),
    queryFn: () => client.collectionsHeld(owner as `0x${string}`),
    enabled: owner !== undefined && (options?.enabled ?? true),
  })

  return withSnfError(client, result)
}
