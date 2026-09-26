import { useQuery } from '@tanstack/react-query'
import type { Quote, QuoteAddLiquidityArgs } from '@sweepnflip/sdk'
import { useSnfContext } from '../context'
import { snfQueryKeys } from '../queryKeys'
import { withSnfError, type SnfQueryOptions, type SnfQueryResult } from './shared'

/** `chainId` is supplied by the active `<SnfProvider>` — never pass it here. */
export type UseSnfQuoteAddLiquidityArgs = Omit<QuoteAddLiquidityArgs, 'chainId'>
export type UseSnfQuoteAddLiquidityOptions = SnfQueryOptions<Quote>
export type UseSnfQuoteAddLiquidityResult = SnfQueryResult<Quote>

/** Mirrors `quoteAddLiquidity`'s own runtime contract: an existing pool's deposit
 * needs a collection and at least one tokenId — this hook is `enabled` only once
 * both are present, so a half-filled deposit form never fires a request the
 * client would reject anyway (a pool that does not exist yet is
 * `useSnfQuoteCreatePool`'s job, not this one's). */
function hasRequiredArgs(
  args: UseSnfQuoteAddLiquidityArgs | undefined,
): args is UseSnfQuoteAddLiquidityArgs {
  if (args === undefined || args.collection === undefined) return false
  return args.tokenIds !== undefined && args.tokenIds.length > 0
}

/**
 * Wraps `SnfClient.quoteAddLiquidity`. Same 20 s `staleTime` / 5 s
 * `refetchInterval` cadence as `useSnfQuoteBuy` — a deposit's required base
 * tracks the same 5 s reserve polling every quote hook in this package follows,
 * both overridable via `options`.
 */
export function useSnfQuoteAddLiquidity(
  args: UseSnfQuoteAddLiquidityArgs | undefined,
  options?: UseSnfQuoteAddLiquidityOptions,
): UseSnfQuoteAddLiquidityResult {
  const { client, chainId, txInvalidationVersion } = useSnfContext()
  const ready = hasRequiredArgs(args)
  const fullArgs: QuoteAddLiquidityArgs | undefined = ready ? { ...args, chainId } : undefined

  const result = useQuery({
    staleTime: 20_000,
    refetchInterval: 5_000,
    ...options,
    queryKey: snfQueryKeys.quoteAddLiquidity(chainId, txInvalidationVersion, fullArgs ?? args),
    queryFn: () => client.quoteAddLiquidity(fullArgs as QuoteAddLiquidityArgs),
    enabled: ready && (options?.enabled ?? true),
  })

  return withSnfError(client, result)
}
