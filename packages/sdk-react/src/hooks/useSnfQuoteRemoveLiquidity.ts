import { useQuery } from '@tanstack/react-query'
import type { Quote, QuoteRemoveLiquidityArgs } from '@sweepnflip/sdk'
import { useSnfContext } from '../context'
import { snfQueryKeys } from '../queryKeys'
import { withSnfError, type SnfQueryOptions, type SnfQueryResult } from './shared'

/** `chainId` is supplied by the active `<SnfProvider>` — never pass it here. */
export type UseSnfQuoteRemoveLiquidityArgs = Omit<QuoteRemoveLiquidityArgs, 'chainId'>
export type UseSnfQuoteRemoveLiquidityOptions = SnfQueryOptions<Quote>
export type UseSnfQuoteRemoveLiquidityResult = SnfQueryResult<Quote>

/** Mirrors `quoteRemoveLiquidity`'s own runtime contract: a withdrawal needs a
 * `pair`, an `owner`, a `mode`, and exactly one of `liquidity`/`bps` — the client
 * itself enforces that XOR at call time; this guard only keeps a half-filled
 * form from firing a request at all. `liquidity` is a `bigint`, so it is
 * checked with `!== undefined`, never falsy-coerced. */
function hasRequiredArgs(
  args: UseSnfQuoteRemoveLiquidityArgs | undefined,
): args is UseSnfQuoteRemoveLiquidityArgs {
  if (args === undefined) return false
  if (args.pair === undefined || args.owner === undefined || args.mode === undefined) return false
  return args.liquidity !== undefined || args.bps !== undefined
}

/**
 * Wraps `SnfClient.quoteRemoveLiquidity`. Same 20 s `staleTime` / 5 s
 * `refetchInterval` cadence as `useSnfQuoteBuy` — a withdrawal's output tracks
 * the same 5 s reserve polling, both overridable via `options`.
 */
export function useSnfQuoteRemoveLiquidity(
  args: UseSnfQuoteRemoveLiquidityArgs | undefined,
  options?: UseSnfQuoteRemoveLiquidityOptions,
): UseSnfQuoteRemoveLiquidityResult {
  const { client, chainId, txInvalidationVersion } = useSnfContext()
  const ready = hasRequiredArgs(args)
  const fullArgs: QuoteRemoveLiquidityArgs | undefined = ready ? { ...args, chainId } : undefined

  const result = useQuery({
    staleTime: 20_000,
    refetchInterval: 5_000,
    ...options,
    queryKey: snfQueryKeys.quoteRemoveLiquidity(chainId, txInvalidationVersion, fullArgs ?? args),
    queryFn: () => client.quoteRemoveLiquidity(fullArgs as QuoteRemoveLiquidityArgs),
    enabled: ready && (options?.enabled ?? true),
  })

  return withSnfError(client, result)
}
