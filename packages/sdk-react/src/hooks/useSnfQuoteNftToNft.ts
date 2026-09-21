import { useQuery } from '@tanstack/react-query'
import type { Quote, QuoteNftToNftArgs } from '@sweepnflip/sdk'
import { useSnfContext } from '../context'
import { snfQueryKeys } from '../queryKeys'
import { withSnfError, type SnfQueryOptions, type SnfQueryResult } from './shared'

/** `chainId` is supplied by the active `<SnfProvider>` — never pass it here. */
export type UseSnfQuoteNftToNftArgs = Omit<QuoteNftToNftArgs, 'chainId'>
export type UseSnfQuoteNftToNftOptions = SnfQueryOptions<Quote>
export type UseSnfQuoteNftToNftResult = SnfQueryResult<Quote>

/** `quoteNftToNft`'s args (R9) have no optional field to gate on the way buy/sell do
 * — `sell.tokenIds`/`buy.count` are always required, so this hook is `enabled` only
 * once BOTH sides of the trade are actually filled in. */
function hasRequiredArgs(args: UseSnfQuoteNftToNftArgs | undefined): args is UseSnfQuoteNftToNftArgs {
  if (args === undefined) return false
  return (
    args.sell.collection !== undefined &&
    args.sell.tokenIds.length > 0 &&
    args.buy.collection !== undefined &&
    args.buy.count > 0
  )
}

/**
 * Wraps `SnfClient.quoteNftToNft` (R9) — the two-leg sell-one/buy-N collection swap.
 * Same 20 s `staleTime` / 5 s `refetchInterval` cadence as the other quote hooks
 * (R18), both overridable via `options`.
 */
export function useSnfQuoteNftToNft(
  args: UseSnfQuoteNftToNftArgs | undefined,
  options?: UseSnfQuoteNftToNftOptions,
): UseSnfQuoteNftToNftResult {
  const { client, chainId, txInvalidationVersion } = useSnfContext()
  const ready = hasRequiredArgs(args)
  const fullArgs: QuoteNftToNftArgs | undefined = ready ? { ...args, chainId } : undefined

  const result = useQuery({
    staleTime: 20_000,
    refetchInterval: 5_000,
    ...options,
    queryKey: snfQueryKeys.quoteNftToNft(chainId, txInvalidationVersion, fullArgs ?? args),
    queryFn: () => client.quoteNftToNft(fullArgs as QuoteNftToNftArgs),
    enabled: ready && (options?.enabled ?? true),
  })

  return withSnfError(client, result)
}
