/**
 * Types for the subgraph transport (R4; 54-SPEC.md). See `cache.ts`/`breaker.ts` for
 * the instance-scoped primitives these shapes feed, `queries.ts` for the GraphQL
 * documents that produce the raw response shapes below, and `subgraph.ts` for
 * `createSubgraphTransport`, the sole module that assembles all of it into a
 * `SubgraphTransport`.
 */

/**
 * The six numbers behind `SnfClientConfig.subgraph` (R4). Defaults mirror the SPEC's
 * own acceptance numbers (60 s / 30 s TTL, 300 s / 900 s lag, 3 failures / 60 s
 * breaker) — `54-CONTEXT.md`'s "Claude's Discretion" note allows adjusting them with a
 * documented reason; none were changed while implementing this plan.
 */
export interface SubgraphTransportOptions {
  /** Pool-query TTL, ms. Default 60_000. */
  readonly ttlMs: number
  /** Inventory-query TTL, ms. Default 30_000. */
  readonly inventoryTtlMs: number
  /** Lag (s) beyond which a result is marked `stale: true`. Default 300. */
  readonly staleLagSeconds: number
  /** Lag (s) beyond which a request throws `UPSTREAM_DEGRADED`. Default 900. */
  readonly degradedLagSeconds: number
  /** Consecutive failures before the breaker opens. Default 3. */
  readonly breakerThreshold: number
  /** Breaker cooldown, ms. Default 60_000. */
  readonly breakerCooldownMs: number
}

/**
 * A transport result, always carrying the freshness that certifies it (R4/R7's "never
 * silently OK" rule) — a caller can never receive `data` without also receiving the
 * block it was read `asOfBlock`, its `lagSeconds`, and whether it's `stale`.
 */
export interface CachedResult<T> {
  readonly data: T
  readonly asOfBlock: bigint
  readonly lagSeconds: number
  readonly stale: boolean
  /** True while a background SWR refetch for this key is in flight; `data` above is
   * still the last-known-good value — never blocked on the refetch. */
  readonly revalidating: boolean
}

/** The raw envelope every Goldsky response is parsed into. `subgraph.ts`'s `execute()`
 * checks `.errors` strictly BEFORE `.data` (RESEARCH Pitfall 3, verified live: this
 * subgraph returns HTTP 200 with an `errors` array and no `data` on a schema
 * mismatch). */
export interface GraphQLEnvelope<T> {
  readonly data?: T
  readonly errors?: readonly { readonly message: string }[]
}

/** `_meta.block` — the freshness anchor every query in `queries.ts` selects alongside
 * its data, in the SAME POST (R4's non-negotiable: a freshness line must describe the
 * exact data it labels, never a separate request's moment). */
export interface SubgraphMetaBlock {
  readonly number: number
  readonly timestamp: number
}

export interface SubgraphMeta {
  readonly block: SubgraphMetaBlock
  readonly hasIndexingErrors?: boolean
}

/** `CircuitBreaker.state` (`breaker.ts`). */
export type BreakerState = 'closed' | 'open' | 'half-open'

// ── Raw per-query response shapes (SnF v2 canonical schema) ────────────────────────

export interface SubgraphTokenCollection {
  readonly id: string
  readonly name: string | null
  readonly symbol: string | null
  readonly wrapper?: { readonly id: string } | null
}

export interface SubgraphToken {
  readonly id: string
  readonly symbol: string
  readonly name: string
  readonly decimals: string | number
  readonly collection?: SubgraphTokenCollection | null
}

/** One `pairs()`/`pair()` row — mirrors `snf-client/src/lib/queries/pools.ts`'s
 * `SubgraphPair`, plus the `_meta` this transport always requests alongside it. */
export interface SubgraphPair {
  readonly id: string
  readonly discrete0: boolean
  readonly discrete1: boolean
  readonly isNFTPool: boolean
  readonly token0: SubgraphToken
  readonly token1: SubgraphToken
  readonly reserve0: string
  readonly reserve1: string
  readonly totalSupply: string
  readonly reserveETH: string
  readonly reserveUSD: string
  readonly volumeToken0: string
  readonly volumeToken1: string
  readonly volumeUSD: string
  readonly txCount: string
  readonly createdAtTimestamp?: string
  readonly createdAtBlockNumber?: string
}

/** One `currency(id:...)` row — mirrors Drops `subgraphQueries.ts`'s `PoolInventory`
 * document (`currency{...}` + `_meta` in one POST). */
export interface SubgraphCurrency {
  readonly id: string
  readonly symbol: string
  readonly name: string
  readonly decimals: string | number
  readonly wrapping: boolean
  readonly tokenIds: readonly string[]
  readonly collection?: { readonly id: string; readonly name: string; readonly symbol: string } | null
}

/**
 * The instance-scoped subgraph transport `createSubgraphTransport` returns — a TTL
 * cache, `_meta.block` freshness gate and circuit breaker, all closed over inside one
 * client instance (R3, R4). `types/client.types.ts`'s `SnfClientContext.transport`
 * imports this exact interface rather than re-declaring a narrower one — see this
 * plan's SUMMARY, Deviations, for why.
 */
export interface SubgraphTransport {
  pools(args?: {
    readonly first?: number
    readonly skip?: number
  }): Promise<CachedResult<readonly SubgraphPair[]>>
  pairById(pair: `0x${string}`): Promise<CachedResult<SubgraphPair | null>>
  inventory(wrapper: `0x${string}`): Promise<CachedResult<SubgraphCurrency | null>>
  /** No cache — a health probe must always be live. Still routed through the breaker. */
  meta(): Promise<CachedResult<SubgraphMeta>>
  /** Clears this instance's cache — used by `txInvalidationVersion` bumps (R15/16). */
  clear(): void
}
