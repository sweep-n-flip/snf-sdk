import { useQuery } from '@tanstack/react-query'
import type { LpPosition } from '@sweepnflip/sdk'
import { useSnfContext } from '../context'
import { snfQueryKeys } from '../queryKeys'
import { withSnfError, type SnfQueryOptions, type SnfQueryResult } from './shared'

export type UseSnfLpPositionOptions = SnfQueryOptions<LpPosition>
export type UseSnfLpPositionResult = SnfQueryResult<LpPosition>

/**
 * Wraps `SnfClient.lpPosition` — an LP holder's live balance, pool share, and
 * underlying base/wNFT/whole-NFT breakdown. Same 20 s `staleTime` / 5 s
 * `refetchInterval` cadence as the quote hooks (a position's underlying value
 * tracks the same 5 s reserve polling), both overridable via `options`.
 * `enabled` only once both `pair` and `owner` are set — a position is
 * meaningless without knowing which pool and which holder.
 */
export function useSnfLpPosition(
  pair: `0x${string}` | undefined,
  owner: `0x${string}` | undefined,
  options?: UseSnfLpPositionOptions,
): UseSnfLpPositionResult {
  const { client, chainId, txInvalidationVersion } = useSnfContext()
  const ready = pair !== undefined && owner !== undefined

  const result = useQuery({
    staleTime: 20_000,
    refetchInterval: 5_000,
    ...options,
    queryKey: snfQueryKeys.lpPosition(chainId, txInvalidationVersion, pair ?? '', owner ?? ''),
    queryFn: () => client.lpPosition(pair as `0x${string}`, owner as `0x${string}`),
    enabled: ready && (options?.enabled ?? true),
  })

  return withSnfError(client, result)
}
