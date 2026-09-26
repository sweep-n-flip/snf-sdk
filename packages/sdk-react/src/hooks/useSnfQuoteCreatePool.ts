import { useQuery } from '@tanstack/react-query'
import type { Quote, QuoteCreatePoolArgs } from '@sweepnflip/sdk'
import { useSnfContext } from '../context'
import { snfQueryKeys } from '../queryKeys'
import { withSnfError, type SnfQueryOptions, type SnfQueryResult } from './shared'

/** `chainId` is supplied by the active `<SnfProvider>` — never pass it here. */
export type UseSnfQuoteCreatePoolArgs = Omit<QuoteCreatePoolArgs, 'chainId'>
export type UseSnfQuoteCreatePoolOptions = SnfQueryOptions<Quote>
export type UseSnfQuoteCreatePoolResult = SnfQueryResult<Quote>

/** Mirrors `quoteCreatePool`'s own runtime contract: a brand-new pool's opening
 * price needs a collection, at least one tokenId, and the `baseAmount` deposit
 * that fixes the exchange rate — `baseAmount` is a `bigint`, so this guard (not
 * `!args.baseAmount`, which would treat a legitimate `0n` as absent) checks it
 * with `!== undefined`. */
function hasRequiredArgs(
  args: UseSnfQuoteCreatePoolArgs | undefined,
): args is UseSnfQuoteCreatePoolArgs {
  if (args === undefined || args.collection === undefined) return false
  if (args.baseAmount === undefined) return false
  return args.tokenIds !== undefined && args.tokenIds.length > 0
}

/**
 * Wraps `SnfClient.quoteCreatePool` — a create/seed UI's LP-and-opening-price
 * preview. Same 20 s `staleTime` / 5 s `refetchInterval` cadence as
 * `useSnfQuoteBuy`, both overridable via `options`.
 */
export function useSnfQuoteCreatePool(
  args: UseSnfQuoteCreatePoolArgs | undefined,
  options?: UseSnfQuoteCreatePoolOptions,
): UseSnfQuoteCreatePoolResult {
  const { client, chainId, txInvalidationVersion } = useSnfContext()
  const ready = hasRequiredArgs(args)
  const fullArgs: QuoteCreatePoolArgs | undefined = ready ? { ...args, chainId } : undefined

  const result = useQuery({
    staleTime: 20_000,
    refetchInterval: 5_000,
    ...options,
    queryKey: snfQueryKeys.quoteCreatePool(chainId, txInvalidationVersion, fullArgs ?? args),
    queryFn: () => client.quoteCreatePool(fullArgs as QuoteCreatePoolArgs),
    enabled: ready && (options?.enabled ?? true),
  })

  return withSnfError(client, result)
}
