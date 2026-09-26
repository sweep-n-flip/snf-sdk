import { useQuery } from '@tanstack/react-query'
import type { RedemptionStatus } from '@sweepnflip/sdk'
import { useSnfContext } from '../context'
import { snfQueryKeys } from '../queryKeys'
import { withSnfError, type SnfQueryOptions, type SnfQueryResult } from './shared'

export type UseSnfRedemptionStatusOptions = SnfQueryOptions<RedemptionStatus>
export type UseSnfRedemptionStatusResult = SnfQueryResult<RedemptionStatus>

/**
 * Wraps `SnfClient.redemptionStatus` — a tri-state probe of whether a
 * collection's wrapper currently lets NFTs redeem out. A redemption guard
 * rarely flips within a session, so this caches for 10 minutes and carries no
 * polling interval — it only re-runs when `txInvalidationVersion` bumps on a
 * completed transaction (both overridable via `options`). `enabled` only once
 * `collection` is set.
 */
export function useSnfRedemptionStatus(
  collection: `0x${string}` | undefined,
  options?: UseSnfRedemptionStatusOptions,
): UseSnfRedemptionStatusResult {
  const { client, chainId, txInvalidationVersion } = useSnfContext()

  const result = useQuery({
    staleTime: 600_000,
    ...options,
    queryKey: snfQueryKeys.redemptionStatus(chainId, txInvalidationVersion, collection ?? ''),
    queryFn: () => client.redemptionStatus(collection as `0x${string}`),
    enabled: collection !== undefined && (options?.enabled ?? true),
  })

  return withSnfError(client, result)
}
