import { getChain } from './chains/registry'
import { resolveCollection } from './collection/resolveCollection'
import { describeError as describeErrorPure } from './describeError'
import { assertParam } from './errors'
import { estimateLadder as estimateLadderPure } from './math/nftPricing'
import { poolInventory } from './inventory/poolInventory'
import { parseReceipt as parseReceiptPure } from './receipt/parseReceipt'
import { buildBuy } from './build/buildBuy'
import { buildNftToNft } from './build/buildNftToNft'
import { buildSell } from './build/buildSell'
import { buildSwap } from './build/buildSwap'
import { quoteBuy } from './quote/quoteBuy'
import { quoteNftToNft } from './quote/quoteNftToNft'
import { quoteSell } from './quote/quoteSell'
import { quoteSwap } from './quote/quoteSwap'
import { resolveProviders } from './providers/defaults'
import { createSubgraphTransport } from './transport/subgraph'
import type { SnfClient, SnfClientConfig, SnfClientContext } from './types/client.types'

/**
 * `createSnfClient` — the ONE documented surface (D-01, D-02; 54-SPEC.md R3). Named
 * after viem's own `createPublicClient` on purpose (D-02): a partner who already knows
 * viem recognises the shape immediately, and there is no `SnF` class, no `new SnF()`.
 *
 * Every piece of state this factory needs — the subgraph transport (its TTL cache and
 * circuit breaker), the resolved providers, and the `txInvalidationVersion` counter —
 * is a local binding created FRESH inside this function call. Nothing lives at module
 * scope (`local/no-module-global-state` is asserted over this whole file, and over
 * every other module under `src/` — see this file's own test). Two calls to
 * `createSnfClient`, even with byte-identical config, therefore share nothing: no
 * cache entry, no breaker state, no counter. That is R3's entire acceptance
 * criterion, and `test/client.test.ts`'s two-chain case proves it by priming one
 * client's transport and asserting the other's mocked `fetch` count stays at 0
 * (T-54-42 in the threat register).
 *
 * This file is `packages/sdk/src`'s single assembly point and its only writer (this
 * plan's own repo note: "plans 10 and 11 must not edit it"). Later plans replace the
 * BODIES of the domain modules imported below (`collection/`, `inventory/`, `quote/`,
 * `build/`, `receipt/`) — none of them touch this file again. If a future method is
 * ever added to the documented surface, its signature goes into `types/client.types.ts`
 * first and its module ships as a stub (the same marker convention `internal/stub.ts`
 * documents), exactly like the twenty modules plan 04 already created — so this file
 * keeps having exactly one writer.
 */

/** Throws `INVALID_PARAMS` unless every present numeric override in
 * `config.subgraph`/`config.defaults` is a finite, positive number — validated at
 * construction, never discovered on first use. */
function assertPositiveFiniteOverrides(
  overrides: Record<string, number | undefined> | undefined,
  group: 'subgraph' | 'defaults',
): void {
  for (const [field, value] of Object.entries(overrides ?? {})) {
    if (value === undefined) continue
    assertParam(
      typeof value === 'number' && Number.isFinite(value) && value > 0,
      `config.${group}.${field} must be a finite, positive number`,
      { field: `${group}.${field}`, value },
    )
  }
}

/** Fails at construction, never at first call (this file's own contract). Delegates
 * chain support to `getChain` (throws `INVALID_PARAMS` on an unsupported chainId) and
 * checks `publicClient` structurally — the SDK never constructs its own transport, so
 * a caller-supplied stand-in that merely LOOKS like a `PublicClient` is accepted; what
 * matters is that `readContract`/`multicall` exist. */
function validateConfig(config: SnfClientConfig): void {
  assertParam(typeof config === 'object' && config !== null, 'config is required', {
    field: 'config',
  })
  getChain(config.chainId)

  const publicClient = config.publicClient as { readContract?: unknown; multicall?: unknown } | undefined
  assertParam(
    publicClient !== undefined &&
      typeof publicClient.readContract === 'function' &&
      typeof publicClient.multicall === 'function',
    'config.publicClient is required and must be a viem PublicClient exposing readContract and multicall',
    { field: 'publicClient' },
  )

  assertPositiveFiniteOverrides(config.subgraph, 'subgraph')
  assertPositiveFiniteOverrides(config.defaults, 'defaults')
}

/**
 * Builds the one object a partner actually holds. Config is validated first (throws
 * synchronously, before any state exists); the context is assembled once from local
 * `const`s; the returned object is frozen and binds every domain function with that
 * context already applied, in D-01's exact order.
 */
export function createSnfClient(config: SnfClientConfig): SnfClient {
  validateConfig(config)

  // `Object.freeze({ ...chain })` — a fresh, frozen COPY of the shared registry entry,
  // never the shared `SNF_CHAINS` reference itself. Mutating `client.chain` must never
  // leak into `SNF_CHAINS` or into any other client built for the same chain.
  const chain = Object.freeze({ ...getChain(config.chainId) })
  const providers = resolveProviders(config)
  const transport = createSubgraphTransport(config)

  // Closed over, never attached to the returned object — a partner can read
  // `client.chainId`/`client.chain` but can never reach the transport's cache or
  // forge an invalidation bump by calling this counter directly.
  let invalidationCounter = 0
  function nextTxInvalidationVersion(): number {
    invalidationCounter += 1
    return invalidationCounter
  }

  const ctx: SnfClientContext = {
    config,
    chain,
    publicClient: config.publicClient,
    providers,
    transport,
    nextTxInvalidationVersion,
  }

  // D-01 order: chainId, chain, then the thirteen methods exactly as `SnfClient`
  // declares them. `Object.keys(client)` is asserted against this same order in
  // `test/client.test.ts`.
  const client = Object.freeze<SnfClient>({
    chainId: chain.chainId,
    chain,

    /** Discovers a collection's wrapper, pools, display labels, royalty and lock
     * state in one call (R6). */
    collection: (address: `0x${string}`) => resolveCollection(ctx, address),

    /** Candidate tokenIds a pool currently holds, plus the buyable ceiling (R7). */
    poolInventory: (pair: `0x${string}`) => poolInventory(ctx, pair),

    /** On-chain cost to buy, reconciled to the wei against the Router (R8). */
    quoteBuy: (args) => quoteBuy(ctx, args),

    /** On-chain proceeds from selling, reconciled to the wei against the Router (R8). */
    quoteSell: (args) => quoteSell(ctx, args),

    /** Two-leg collection→collection quote: sell one, buy the other (R9). */
    quoteNftToNft: (args) => quoteNftToNft(ctx, args),

    /** Fungible↔fungible quote, delegate-aware (R10). */
    quoteSwap: (args) => quoteSwap(ctx, args),

    /** Offline, `reserves`-only per-unit price ladder (R12) — never on-chain-
     * authoritative, never a source for a transaction bound. Issues zero RPC calls. */
    estimateLadder: (reserves, n) => estimateLadderPure(reserves, n),

    /** Builds an unsigned buy `ExecutionPlan`, bounds re-quoted on-chain (R13). */
    buildBuy: (args) => buildBuy(ctx, args),

    /** Builds an unsigned sell `ExecutionPlan`, bounds re-quoted on-chain (R13). */
    buildSell: (args) => buildSell(ctx, args),

    /** Builds the user-driven, multi-step NFT×NFT `ExecutionPlan` (R13, R15, INV-17). */
    buildNftToNft: (args) => buildNftToNft(ctx, args),

    /** Builds an unsigned fungible↔fungible `ExecutionPlan` (R13). */
    buildSwap: (args) => buildSwap(ctx, args),

    /** Attributes items/fees from an already-mined receipt's own logs (R16).
     * Synchronous — bumps this client's own `txInvalidationVersion` counter. */
    parseReceipt: (receipt) => parseReceiptPure(ctx, receipt),

    /** Maps any unknown throwable to a stable `SnfError` (R17). Pure — needs no
     * context. */
    describeError: (e: unknown) => describeErrorPure(e),
  })

  return client
}
