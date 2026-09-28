import { getAddress } from 'viem'

import { assertParam } from '../errors'

/**
 * Small, dependency-free primitives every portfolio read shares: address validation
 * with the package's own `INVALID_PARAMS` convention, and a bounded-concurrency
 * mapper so a whole-wallet scan never opens more RPC round trips at once than a
 * public endpoint can take.
 */

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

/** The concurrency cap every portfolio read uses for its per-pair/per-collection
 * fan-out — chosen to stay well under a public RPC's default rate limit while still
 * pipelining a wallet with several dozen positions. */
export const PORTFOLIO_CONCURRENCY = 4

/** Validates a caller-supplied address against this package's one accepted shape
 * (`0x` + 40 hex digits) and returns it checksummed. The zero address is a valid
 * owner (used by the live backstop's `balanceOf(0x0) = MINIMUM_LIQUIDITY` check) — it
 * is never special-cased out. */
export function normalizeAddress(value: string, field: string): `0x${string}` {
  assertParam(ADDRESS_RE.test(value), `${field} must be a well-formed 0x address`, {
    field,
    value,
  })
  return getAddress(value)
}

/**
 * Runs `fn` over `items` with at most `limit` calls in flight at once, preserving the
 * input order in the returned array regardless of which call finishes first. A fixed
 * pool of `limit` workers (never more, never fewer than `items.length` allows) each
 * pull the next index in turn — simpler and just as exact as a semaphore for this
 * package's own fan-outs, none of which need to cancel in flight work.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length)
  let nextIndex = 0

  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex
      nextIndex += 1
      if (index >= items.length) return
      results[index] = await fn(items[index] as T, index)
    }
  }

  const workerCount = Math.min(limit, items.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return results
}
