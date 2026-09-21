import { notImplemented } from '../internal/stub'
import type { SnfClientConfig, SubgraphTransport } from '../types/client.types'

/**
 * Instance-scoped subgraph transport: TTL cache (default 60s pools / 30s inventory),
 * `_meta.block` freshness gate (stale > 300s, `UPSTREAM_DEGRADED` > 900s), a circuit
 * breaker (3 failures / 60s cooldown), and concurrent-call dedupe — one query in
 * flight per key (R4). Must be closed over inside `createSnfClient`, never
 * module-scope (R3).
 *
 * @gsd-stub — implemented by plan 05. Source analog: snf-client/src/lib/graphql.ts +
 * snf-drops-registration/.../genesis/inventory/subgraphQueries.ts (branch feature/registration).
 */
export function createSubgraphTransport(config: SnfClientConfig): SubgraphTransport {
  void config
  return notImplemented('createSubgraphTransport', '05')
}
