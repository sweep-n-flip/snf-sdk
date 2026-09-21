import type { UseQueryOptions, UseQueryResult } from '@tanstack/react-query'
import type { SnfClient, SnfError } from '@sweepnflip/sdk'

/**
 * Internal wiring shared by every `useSnf*` query hook — NOT part of this package's
 * public surface (not exported from `hooks/index.ts`/`src/index.ts`; see plan
 * 16's own truth: "exactly the six read hooks... no other public hook names"). This
 * file exists so `useSnfCollection`/`useSnfPoolInventory`/`useSnfQuoteBuy`/
 * `useSnfQuoteSell`/`useSnfQuoteNftToNft` each stay a small, reviewable wrapper
 * (plan's own ≤120-line-per-hook acceptance) instead of repeating the same
 * error-passthrough plumbing five times.
 */

/** Every hook's own options type — full react-query `UseQueryOptions` minus the two
 * fields this package always owns (`queryKey`/`queryFn`). A hook spreads its own
 * defaults (`staleTime`, `refetchInterval`) BEFORE `options` so a caller can override
 * them, but always computes `queryKey`/`queryFn`/`enabled` itself AFTER, so those can
 * never be silently clobbered by a caller-supplied option object. */
export type SnfQueryOptions<T> = Omit<UseQueryOptions<T, SnfError>, 'queryKey' | 'queryFn'>

export interface SnfQueryResult<T> extends Omit<UseQueryResult<T, SnfError>, 'error'> {
  readonly error: SnfError | null
}

/**
 * Wraps a raw react-query result so `error` is always a real `SnfError` — never a
 * react-query-passthrough of whatever the `queryFn` happened to throw (T-54-93).
 * `client.describeError` is idempotent on an `SnfError` (it returns the SAME instance
 * unchanged — `packages/sdk/src/describeError.ts`'s own first check), so a query that
 * already rejected with a proper `SnfError` (every core domain method does, per R5)
 * survives this call byte-identical — proven by `test/hooks.test.tsx`'s "error
 * passthrough" case (`instanceof SnfError`, same `code`, not a react-query wrapper).
 */
export function withSnfError<T>(client: SnfClient, result: UseQueryResult<T, SnfError>): SnfQueryResult<T> {
  return { ...result, error: result.error ? client.describeError(result.error) : null }
}
