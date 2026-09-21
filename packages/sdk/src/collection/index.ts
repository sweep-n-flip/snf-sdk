/**
 * `src/collection/*` barrel (R6; 54-SPEC.md) — the collection-identity, royalty, pool
 * ranking and discovery surface plan 10 ships. `client.ts` (plan 09) imports
 * `resolveCollection` directly from `./resolveCollection`, not through this barrel —
 * this file exists so a future consumer of the module (tests, plan 11+) has one
 * import path for everything in this directory.
 */
export { getCollectionLabels, isAddressLike, needsNameFallback, shortenAddress } from './labels'
export { rankPoolsByLiquidity } from './rankPools'
export type { ReserveUsdByPair } from './rankPools'
export { resolveCollection } from './resolveCollection'
export { resolveRoyalty } from './royalty'
export type { ResolveRoyaltyOptions } from './royalty'
