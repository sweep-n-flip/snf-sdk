/**
 * `snfQueryKeys` — every key factory takes `chainId` and `v` (the active
 * `SnfProvider`'s `txInvalidationVersion`) as its first two elements, always in that
 * order. This is what makes both guarantees declarative rather than
 * something a caller has to remember at N call sites:
 *
 * - Per-`chainId` cache isolation: `chainId` is baked into the key
 * ITSELF, not just into a `queryClient.invalidateQueries({ predicate })` someone
 * would otherwise have to write correctly. Two `useSnfCollection` hooks mounted
 * under providers for different chains hash to different keys even for the
 * BYTE-IDENTICAL `address` argument.
 * - Invalidation on a completed transaction: bumping `v` (via the
 * context's `bumpInvalidation()`, called once by `useSnfCheckout` on a checkout's
 * final success) changes the key itself, so react-query treats every prior entry
 * as abandoned and every mounted observer refetches — no `invalidateQueries` call
 * needs to enumerate which query types a transaction might affect, and no future
 * hook can be added without also being invalidated (the key shape structurally
 * forces it).
 *
 * `args` (for the three quote factories) is serialized through `serializeArgs` before
 * joining the key array — react-query's default `hashKey` is a `JSON.stringify` over
 * the whole `queryKey`, which THROWS on a raw `bigint` ("Do not know how to serialize
 * a BigInt"). `QuoteBuyArgs.amount`/`QuoteSellArgs.amount` (fractional wNFT amounts,
 * `types/quote.types.ts`) are exactly that: a `bigint`. Embedding the already-`JSON.
 * stringify`'d string (bigints coerced to their decimal string form) instead of the
 * raw object keeps every key a plain array of primitives, which is always hashable
 * regardless of what a future quote-args shape adds.
 */

function serializeArgs(args: unknown): string {
  return JSON.stringify(args, (_key: string, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  )
}

export const snfQueryKeys = {
  collection: (chainId: number, v: number, address: string) =>
    ['snf', 'collection', chainId, v, address.toLowerCase()] as const,

  inventory: (chainId: number, v: number, pair: string) =>
    ['snf', 'inventory', chainId, v, pair.toLowerCase()] as const,

  quoteBuy: (chainId: number, v: number, args: unknown) =>
    ['snf', 'quoteBuy', chainId, v, serializeArgs(args)] as const,

  quoteSell: (chainId: number, v: number, args: unknown) =>
    ['snf', 'quoteSell', chainId, v, serializeArgs(args)] as const,

  quoteNftToNft: (chainId: number, v: number, args: unknown) =>
    ['snf', 'quoteNftToNft', chainId, v, serializeArgs(args)] as const,

  quoteAddLiquidity: (chainId: number, v: number, args: unknown) =>
    ['snf', 'quoteAddLiquidity', chainId, v, serializeArgs(args)] as const,

  quoteCreatePool: (chainId: number, v: number, args: unknown) =>
    ['snf', 'quoteCreatePool', chainId, v, serializeArgs(args)] as const,

  quoteRemoveLiquidity: (chainId: number, v: number, args: unknown) =>
    ['snf', 'quoteRemoveLiquidity', chainId, v, serializeArgs(args)] as const,

  lpPosition: (chainId: number, v: number, pair: string, owner: string) =>
    ['snf', 'lpPosition', chainId, v, pair.toLowerCase(), owner.toLowerCase()] as const,

  redemptionStatus: (chainId: number, v: number, collection: string) =>
    ['snf', 'redemptionStatus', chainId, v, collection.toLowerCase()] as const,
} as const
