import { useQuery } from '@tanstack/react-query'
import type { CollectionInfo } from '@sweepnflip/sdk'
import { useSnfContext } from '../context'
import { snfQueryKeys } from '../queryKeys'
import { withSnfError, type SnfQueryOptions, type SnfQueryResult } from './shared'

export type UseSnfCollectionOptions = SnfQueryOptions<CollectionInfo>
export type UseSnfCollectionResult = SnfQueryResult<CollectionInfo>

/**
 * Wraps `SnfClient.collection` — a collection's wrapper, pools, display labels,
 * royalty and redemption-lock state. `staleTime` 60 s (this identity data rarely
 * changes within a session); refetches when `txInvalidationVersion` bumps (a
 * completed transaction can flip `redemptionLocked` or surface a new pool) or when the
 * active `SnfProvider`'s `chainId` changes — both are baked into the query key
 * (`queryKeys.ts`). `enabled` only once `address` is set.
 */
export function useSnfCollection(
  address: `0x${string}` | undefined,
  options?: UseSnfCollectionOptions,
): UseSnfCollectionResult {
  const { client, chainId, txInvalidationVersion } = useSnfContext()

  const result = useQuery({
    staleTime: 60_000,
    ...options,
    queryKey: snfQueryKeys.collection(chainId, txInvalidationVersion, address ?? ''),
    queryFn: () => client.collection(address as `0x${string}`),
    enabled: address !== undefined && (options?.enabled ?? true),
  })

  return withSnfError(client, result)
}
