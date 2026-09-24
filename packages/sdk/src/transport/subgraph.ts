import { getChain } from '../chains/registry'
import { SnfError } from '../errors'
import type { SnfClientConfig, SubgraphTransport } from '../types/client.types'
import { CircuitBreaker } from './breaker'
import { TtlCache } from './cache'
import { META_QUERY, PAIR_BY_ID_QUERY, POOL_INVENTORY_QUERY, POOLS_QUERY } from './queries'
import type {
  CachedResult,
  GraphQLEnvelope,
  SubgraphCurrency,
  SubgraphMeta,
  SubgraphPair,
  SubgraphTransportOptions,
} from './subgraph.types'

/** this rule's own acceptance numbers — 60 s / 30 s TTL, 300 s / 900 s lag, 3 failures / 60 s
 * breaker. Overridable per client via `SnfClientConfig.subgraph`. */
const DEFAULT_OPTIONS: SubgraphTransportOptions = {
  ttlMs: 60_000,
  inventoryTtlMs: 30_000,
  staleLagSeconds: 300,
  degradedLagSeconds: 900,
  breakerThreshold: 3,
  breakerCooldownMs: 60_000,
}

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/
const REQUEST_TIMEOUT_MS = 10_000

/** The SWR window is `ttlMs * 5` — documented, and overridable only through `ttlMs`
 * itself (there is no separate `swrMs` config key; see `SubgraphTransportOptions`). */
function swrWindow(ttlMs: number): number {
  return ttlMs * 5
}

/** Lowercases every string variable that matches a 0x-hex address, unconditionally, at
 * the transport boundary. A checksummed id returns `currency: null` with NO GraphQL
 * error, which reads identically to "empty pool" (a known subgraph pitfall, verified
 * live) — so this can never be conditional on the caller having remembered to
 * lowercase it themselves. */
function lowercaseAddressVars(
  variables: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (variables === undefined) return undefined
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(variables)) {
    out[key] = typeof value === 'string' && HEX_ADDRESS.test(value) ? value.toLowerCase() : value
  }
  return out
}

/**
 * Instance-scoped subgraph transport: one `TtlCache`, one `CircuitBreaker`,
 * closed over inside the object this factory returns — never module-scope state. Two
 * transports built from two different `SnfClientConfig`s (two chains, or the same
 * chain twice) share NOTHING — priming one leaves the other's cache and breaker
 * untouched.
 */
export function createSubgraphTransport(config: SnfClientConfig): SubgraphTransport {
  const chain = getChain(config.chainId)
  const options: SubgraphTransportOptions = {
    ttlMs: config.subgraph?.ttlMs ?? DEFAULT_OPTIONS.ttlMs,
    inventoryTtlMs: config.subgraph?.inventoryTtlMs ?? DEFAULT_OPTIONS.inventoryTtlMs,
    staleLagSeconds: config.subgraph?.staleLagSeconds ?? DEFAULT_OPTIONS.staleLagSeconds,
    degradedLagSeconds: config.subgraph?.degradedLagSeconds ?? DEFAULT_OPTIONS.degradedLagSeconds,
    breakerThreshold: config.subgraph?.breakerThreshold ?? DEFAULT_OPTIONS.breakerThreshold,
    breakerCooldownMs: config.subgraph?.breakerCooldownMs ?? DEFAULT_OPTIONS.breakerCooldownMs,
  }
  const cache = new TtlCache()
  const breaker = new CircuitBreaker({
    threshold: options.breakerThreshold,
    cooldownMs: options.breakerCooldownMs,
  })

  /** One POST. Only the `fetch` call itself is routed through the breaker — a
   * network-level rejection (DNS failure, abort, connection refused) is what "3
   * consecutive failures" means for this rule's breaker; an HTTP error status or a GraphQL
   * `errors` payload is a normal (non-breaker) rejection of this specific call. */
  async function execute<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const body = JSON.stringify({ query, variables: lowercaseAddressVars(variables) })

    const response = await breaker.exec(() =>
      fetch(chain.subgraphUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }),
    )

    if (!response.ok) {
      throw new SnfError(
        'UPSTREAM_DEGRADED',
        `Subgraph responded ${String(response.status)} ${response.statusText}`,
        { details: { status: response.status } },
      )
    }

    const json = (await response.json()) as GraphQLEnvelope<T>

    // Checked BEFORE `data` — this subgraph returns HTTP 200 with an `errors` array
    // and no `data` on a schema mismatch (a known subgraph pitfall, verified live).
    if (json.errors !== undefined && json.errors.length > 0) {
      throw new SnfError('UPSTREAM_DEGRADED', 'Subgraph returned GraphQL errors.', {
        details: { graphqlErrors: json.errors },
      })
    }
    if (json.data === undefined) {
      throw new SnfError('UPSTREAM_DEGRADED', 'Subgraph returned no data.')
    }
    return json.data
  }

  /** Whole integer seconds on both sides (Edge `precision`) — never a float. A lag
   * of exactly `staleLagSeconds` (300) is still fresh; a lag of exactly
   * `degradedLagSeconds` (900) is stale but NOT yet degraded — degraded starts
   * strictly above it. `hasIndexingErrors` forces `stale: true` regardless of lag
   * (never silently OK). */
  function gradeFreshness(meta: SubgraphMeta): { asOfBlock: bigint; lagSeconds: number; stale: boolean } {
    const lagSeconds = Math.max(0, Math.floor(Date.now() / 1000) - meta.block.timestamp)
    if (lagSeconds > options.degradedLagSeconds) {
      throw new SnfError(
        'UPSTREAM_DEGRADED',
        `Subgraph lag ${String(lagSeconds)}s exceeds the degraded threshold (${String(options.degradedLagSeconds)}s).`,
        { details: { lagSeconds, asOfBlock: meta.block.number } },
      )
    }
    const stale = lagSeconds > options.staleLagSeconds || meta.hasIndexingErrors === true
    return { asOfBlock: BigInt(meta.block.number), lagSeconds, stale }
  }

  function toCachedResult<T>(data: T, meta: SubgraphMeta, revalidating: boolean): CachedResult<T> {
    const { asOfBlock, lagSeconds, stale } = gradeFreshness(meta)
    return { data, asOfBlock, lagSeconds, stale, revalidating }
  }

  return {
    async pools(args) {
      const key = `pools:${String(config.chainId)}:${JSON.stringify(args ?? {})}`
      const loader = () =>
        execute<{ pairs: readonly SubgraphPair[]; _meta: SubgraphMeta }>(POOLS_QUERY, {
          first: args?.first ?? 100,
          skip: args?.skip ?? 0,
        })
      const { value, revalidating } = await cache.get(key, loader, {
        ttlMs: options.ttlMs,
        swrMs: swrWindow(options.ttlMs),
      })
      return toCachedResult(value.pairs, value._meta, revalidating)
    },

    async pairById(pair) {
      const key = `pair:${String(config.chainId)}:${pair.toLowerCase()}`
      const loader = () =>
        execute<{ pair: SubgraphPair | null; _meta: SubgraphMeta }>(PAIR_BY_ID_QUERY, { id: pair })
      const { value, revalidating } = await cache.get(key, loader, {
        ttlMs: options.ttlMs,
        swrMs: swrWindow(options.ttlMs),
      })
      return toCachedResult(value.pair, value._meta, revalidating)
    },

    async inventory(wrapper) {
      const key = `inv:${String(config.chainId)}:${wrapper.toLowerCase()}`
      // `tokenIds` does not paginate: the whole array comes back regardless of length,
      // so this transport caps what it *consumes* downstream rather than
      // relying on the query to truncate.
      const loader = () =>
        execute<{ currency: SubgraphCurrency | null; _meta: SubgraphMeta }>(POOL_INVENTORY_QUERY, {
          wrapper,
        })
      const { value, revalidating } = await cache.get(key, loader, {
        ttlMs: options.inventoryTtlMs,
        swrMs: swrWindow(options.inventoryTtlMs),
      })
      return toCachedResult(value.currency, value._meta, revalidating)
    },

    async meta() {
      // No cache — a health probe must be live — but still through the breaker.
      const data = await execute<{ _meta: SubgraphMeta }>(META_QUERY)
      return toCachedResult(data._meta, data._meta, false)
    },

    clear() {
      cache.clear()
    },
  }
}
