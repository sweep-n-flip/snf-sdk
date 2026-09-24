import { useQuery } from '@tanstack/react-query'
import type { Quote, QuoteBuyArgs } from '@sweepnflip/sdk'
import { useSnfContext } from '../context'
import { snfQueryKeys } from '../queryKeys'
import { withSnfError, type SnfQueryOptions, type SnfQueryResult } from './shared'

/** `chainId` is supplied by the active `<SnfProvider>` — never pass it here. */
export type UseSnfQuoteBuyArgs = Omit<QuoteBuyArgs, 'chainId'>
export type UseSnfQuoteBuyOptions = SnfQueryOptions<Quote>
export type UseSnfQuoteBuyResult = SnfQueryResult<Quote>

/** Mirrors `quoteBuy`'s own runtime contract: exactly one of `count`/`tokenIds`/
 * `amount` is required — this hook is `enabled` only once one is actually present, so
 * a partially-filled form never fires a request the client would reject anyway. */
function hasRequiredArgs(args: UseSnfQuoteBuyArgs | undefined): args is UseSnfQuoteBuyArgs {
  if (args === undefined || args.collection === undefined) return false
  return args.count !== undefined || args.tokenIds !== undefined || args.amount !== undefined
}

/**
 * Wraps `SnfClient.quoteBuy`. `staleTime` 20 s — just under the quote's own 30 s
 * `expiresAt` — and a 5 s `refetchInterval` so a displayed price never outlives the
 * on-chain reserves it was read against, both overridable via `options`.
 */
export function useSnfQuoteBuy(
  args: UseSnfQuoteBuyArgs | undefined,
  options?: UseSnfQuoteBuyOptions,
): UseSnfQuoteBuyResult {
  const { client, chainId, txInvalidationVersion } = useSnfContext()
  const ready = hasRequiredArgs(args)
  const fullArgs: QuoteBuyArgs | undefined = ready ? { ...args, chainId } : undefined

  const result = useQuery({
    staleTime: 20_000,
    refetchInterval: 5_000,
    ...options,
    queryKey: snfQueryKeys.quoteBuy(chainId, txInvalidationVersion, fullArgs ?? args),
    queryFn: () => client.quoteBuy(fullArgs as QuoteBuyArgs),
    enabled: ready && (options?.enabled ?? true),
  })

  return withSnfError(client, result)
}
