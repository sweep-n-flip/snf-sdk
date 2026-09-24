import type { SnfErrorCode } from '../errors.types'
import type { TokenRef } from '../types/amount.types'

/**
 * Types for `src/routing/*`. Ported from the production AMM client's own routing
 * types, renamed for this SDK's surface. No inline types
 * live in the routing modules themselves (`CLAUDE.md`: "Separate types").
 */

/** Which end of a swap the caller is on. A `buy` spends `baseToken` to receive the
 * collection/wrapper; a `sell` spends the collection/wrapper to receive `baseToken`. */
export type RouteSide = 'buy' | 'sell'

/** Which pair slot (`token0`/`token1`) the NFT wrapper occupies — the wrapper is
 * never assumed to be `token1` (root `CLAUDE.md`, "What NOT to Do": "Don't assume
 * NFT wrapper is always token1 — it can be token0 (check `discrete0`/`discrete1` or
 * `nftWrapperAddress`)"). */
export type WrapperSide = 'token0' | 'token1'

/** The `address[]` a Router entry point expects. Never empty — every builder in this
 * package returns a path of at least two entries. */
export type RoutePath = readonly `0x${string}`[]

/**
 * Minimal structural pool shape every routing helper reads — deliberately not the
 * feature-level `NFTPool` shape the production AMM client uses, so this package never
 * depends on a UI type (mirrors that client's own `RoutablePoolLike`).
 *
 * `token0`/`token1` are the pool's on-chain pair addresses. `discrete0`/`discrete1`
 * are the subgraph's own flags for which side is the NFT wrapper — present only
 * when `pool` came from a subgraph read, and preferred over an address comparison
 * when present. `baseToken.address` on a `PoolRef` is ALWAYS the pool's concrete
 * on-chain quote-side address (the chain's `WETH()`/quote-token slot), never `null`
 * — `TokenRef.address: null` is a partner-facing "native" convention for `Amount`/
 * quote-arg surfaces, not for this internal pair-address shape, which always needs
 * a real address to build a `path[]`.
 */
export interface PoolRef {
  readonly pair: `0x${string}`
  readonly token0: `0x${string}`
  readonly token1: `0x${string}`
  readonly discrete0?: boolean
  readonly discrete1?: boolean
  readonly baseToken: TokenRef
  /**
   * True when this pool's base token is curated `routing: 'direct-only'` for its
   * chain — e.g. a Robinhood Chain stock token, whose delegate holds
   * ~1e-9 of supply so any `[WETH, <stock>, collection]` hop reverts or returns a
   * garbage quote). The caller (the client's providers layer, which owns the
   * chain-curated token list) resolves this flag; `src/routing/*` only consumes
   * it, never curates it.
   */
  readonly isDirectOnlyBase?: boolean
}

/** Why `evaluateRouteBlock` refuses to build a route — a closed union.
 * `ROUTE_BLOCK_CODE` in `routeBlock.ts` maps every member to an `SnfErrorCode`;
 * that map's exhaustiveness is enforced both by its `Record<RouteBlockReason, ...>`
 * type and by a runtime test over `ROUTE_BLOCK_REASONS`. */
export const ROUTE_BLOCK_REASONS = [
  'direct-only',
  'no-pair',
  'no-liquidity',
  'different-base',
  'unsupported-token',
] as const

export type RouteBlockReason = (typeof ROUTE_BLOCK_REASONS)[number]

/**
 * Result of `evaluateDirectOnly` (`directOnlyRouting.ts`) — `viablePayTokens` is
 * non-empty whenever at least one candidate pool exists (a blocked
 * route is always an explicit typed failure with an alternative, never a silently empty
 * quote).
 */
export interface DirectOnlyResult {
  readonly blocked: boolean
  readonly viablePayTokens: readonly TokenRef[]
}

/** Args for `isDirectOnly` (`directOnlyRouting.ts`). */
export interface IsDirectOnlyArgs {
  readonly path: RoutePath
  /** Every curated direct-only-base address for the active chain — resolved by the
   * caller (the client's providers layer), never curated inside `src/routing/*`. */
  readonly directOnlyBaseAddresses: readonly `0x${string}`[]
}

/** Args for `evaluateDirectOnly` (`directOnlyRouting.ts`). */
export interface EvaluateDirectOnlyArgs extends IsDirectOnlyArgs {
  readonly candidates: readonly PoolRef[]
}

/** The reason→code record `routeBlock.ts` exports, typed here so both the record
 * and its exhaustiveness test import the same shape. */
export type RouteBlockCodeMap = Readonly<Record<RouteBlockReason, SnfErrorCode>>

/** Args for `evaluateRouteBlock` (`routeBlock.ts`). */
export interface EvaluateRouteBlockArgs {
  /** Every candidate pool for the requested collection (possibly empty). */
  readonly candidates: readonly PoolRef[]
  /** The resolved router path for the requested route, when one could be built. */
  readonly path: RoutePath | undefined
  readonly directOnlyBaseAddresses: readonly `0x${string}`[]
  /** Caller already determined the requested token/param is invalid. */
  readonly unsupportedToken?: boolean
  /** Caller already determined the sole candidate pool has no reserves. */
  readonly noLiquidity?: boolean
  /** NFT×NFT only — the two legs' own base tokens (Different bases ⇒ `NO_ROUTE`). */
  readonly nftToNft?: { readonly sellPoolBase: TokenRef; readonly buyPoolBase: TokenRef }
}

/** Result of `evaluateRouteBlock` (`routeBlock.ts`). */
export interface RouteBlockResult {
  readonly blocked: boolean
  readonly reason?: RouteBlockReason
  readonly viablePayTokens: readonly TokenRef[]
}

/** Args for `buildNftRoutePath` (`nftRoutePaths.ts`). */
export interface BuildNftRoutePathArgs {
  readonly collection: `0x${string}`
  readonly baseToken: `0x${string}`
  readonly side: RouteSide
}

/** Args for `buildWnftRoutePath` (`nftRoutePaths.ts`). */
export interface BuildWnftRoutePathArgs {
  readonly wrapper: `0x${string}`
  readonly baseToken: `0x${string}`
  readonly side: RouteSide
}

/** Result of `scaleWnftAmount` (`wnftPathScale.ts`) — `wholeCount` NFTs plus a
 * `remainderUnits` wrapper-unit fraction; the two always sum back to the input
 * exactly. */
export interface WnftScaleResult {
  readonly wholeCount: number
  readonly remainderUnits: bigint
}
