import { useQuery } from '@tanstack/react-query'
import type { Quote, QuoteSellArgs } from '@sweepnflip/sdk'
import { useSnfContext } from '../context'
import { snfQueryKeys } from '../queryKeys'
import { withSnfError, type SnfQueryOptions, type SnfQueryResult } from './shared'

/** `chainId` is supplied by the active `<SnfProvider>` — never pass it here. */
export type UseSnfQuoteSellArgs = Omit<QuoteSellArgs, 'chainId'>
export type UseSnfQuoteSellOptions = SnfQueryOptions<Quote>
export type UseSnfQuoteSellResult = SnfQueryResult<Quote>

/** Mirrors `quoteSell`'s own runtime contract (R8): exactly one of `tokenIds`/
 * `count`/`amount` is required. */
function hasRequiredArgs(args: UseSnfQuoteSellArgs | undefined): args is UseSnfQuoteSellArgs {
  if (args === undefined || args.collection === undefined) return false
  return args.tokenIds !== undefined || args.count !== undefined || args.amount !== undefined
}

/**
 * Wraps `SnfClient.quoteSell` (R8). Same 20 s `staleTime` / 5 s `refetchInterval`
 * cadence as `useSnfQuoteBuy` (R18), both overridable via `options`.
 */
export function useSnfQuoteSell(
  args: UseSnfQuoteSellArgs | undefined,
  options?: UseSnfQuoteSellOptions,
): UseSnfQuoteSellResult {
  const { client, chainId, txInvalidationVersion } = useSnfContext()
  const ready = hasRequiredArgs(args)
  const fullArgs: QuoteSellArgs | undefined = ready ? { ...args, chainId } : undefined

  const result = useQuery({
    staleTime: 20_000,
    refetchInterval: 5_000,
    ...options,
    queryKey: snfQueryKeys.quoteSell(chainId, txInvalidationVersion, fullArgs ?? args),
    queryFn: () => client.quoteSell(fullArgs as QuoteSellArgs),
    enabled: ready && (options?.enabled ?? true),
  })

  return withSnfError(client, result)
}
