import { formatUnits } from 'viem'

import type { Amount, TokenRef } from '../types/amount.types'
import type { SnfClientContext } from '../types/client.types'

/**
 * USD is optional and comes ONLY from the partner's `prices` provider — never from the
 * subgraph's own USD fields (they read `0` on chains with no price oracle, which is
 * indistinguishable from a genuine zero-value pool). One provider call per distinct
 * token per read, never repeated for a token that appears more than once in the same
 * caller's batch. A price is accepted only when it is a finite, positive number — a
 * throw, `undefined`, `NaN`, `Infinity`, `0` or a negative number all collapse to the
 * identical outcome: `undefined`, never `0`-for-unknown.
 */

function isUsablePrice(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

async function safePrice(ctx: SnfClientContext, token: TokenRef): Promise<number | undefined> {
  const prices = ctx.providers.prices
  if (prices === undefined) return undefined
  try {
    if (token.isNative) {
      const raw = await prices.getNativeUsd(ctx.chain.chainId)
      return isUsablePrice(raw) ? raw : undefined
    }
    if (token.address === null || prices.getTokenUsd === undefined) return undefined
    const raw = await prices.getTokenUsd(ctx.chain.chainId, token.address)
    return isUsablePrice(raw) ? raw : undefined
  } catch {
    return undefined
  }
}

/** The map key for a token: its address lowercased, or the literal `'native'` when
 * the token carries no address (this package's own `TokenRef` convention for a native
 * leg with no on-chain identity of its own). */
function tokenKey(token: TokenRef): string {
  return token.address === null ? 'native' : token.address.toLowerCase()
}

/**
 * Reads a USD price for every distinct token in `tokens`, deduplicated by `tokenKey`,
 * with concurrency left to `Promise.all` (this is a read-only, provider-scoped batch,
 * never more than one call per distinct token — no separate cap is needed).
 */
export async function readUsdPrices(
  ctx: SnfClientContext,
  tokens: readonly TokenRef[],
): Promise<ReadonlyMap<string, number | undefined>> {
  const distinct = new Map<string, TokenRef>()
  for (const token of tokens) {
    const key = tokenKey(token)
    if (!distinct.has(key)) distinct.set(key, token)
  }

  const entries = await Promise.all(
    Array.from(distinct.entries()).map(async ([key, token]) => [key, await safePrice(ctx, token)] as const),
  )
  return new Map(entries)
}

/** `Number(formatUnits(amount.value, amount.decimals)) * price`, or `undefined` when
 * `price` itself is `undefined` — never a silent `0`. */
export function toUsd(amount: Amount, price: number | undefined): number | undefined {
  if (price === undefined) return undefined
  return Number(formatUnits(amount.value, amount.decimals)) * price
}
