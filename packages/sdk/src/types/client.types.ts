import type { PublicClient } from 'viem'

import type { SnfError } from '../errors'
import type { SnfChainConfig, SnfChainId } from '../chains/chains.types'
import type { LadderResult } from '../math/nftPricing.types'
import type { ReceiptLike, SwapReceipt } from '../receipt/receipt.types'
import type { SubgraphTransport } from '../transport/subgraph.types'
import type { CollectionInfo } from './collection.types'
import type { PoolInventory } from './inventory.types'
import type { BuildArgs, ExecutionPlan } from './plan.types'
import type { DataProviders } from './providers.types'
import type { Quote, QuoteBuyArgs, QuoteNftToNftArgs, QuoteSellArgs, QuoteSwapArgs } from './quote.types'

// Re-exported (not just imported) so `types/index.ts`'s `export type * from
// './client.types'` still forwards `SubgraphTransport` from the package root — the
// interface's canonical home is now `transport/subgraph.types.ts`, not a
// local declaration here. See this plan's SUMMARY, Deviations, for why this module's local
// `query<T>()`-only shape was replaced rather than kept alongside the real one.
export type { SubgraphTransport }

/**
 * The structural subset of viem's `PublicClient` this package actually calls: reads
 * only — `readContract`, `multicall`, `simulateContract`, `estimateContractGas`,
 * `getBlockNumber`, `getBalance` — plus the `chain` property `runPreflight` compares
 * against `ctx.chain.chainId` to catch a wallet on the wrong network before any read.
 * (Grep `publicClient\.[a-zA-Z]+` across `src/` for the exhaustive, verified list this
 * `Pick` is built from — plan snf-102-08.)
 *
 * viem's bare, non-chain-parameterized `PublicClient` (`PublicClient<Transport, Chain
 * | undefined>`, the type this field held before) is NOT assignable from a client
 * built for a chain with custom `formatters` — Base is OP-Stack, and its formatters
 * add a `"deposit"` transaction variant to `getBlock()`'s inferred return type that
 * the un-parameterized type does not declare. TypeScript's return-type covariance
 * check (always on, independent of `strict`) then rejects the assignment with TS2719
 * — even though this package never calls `getBlock` anywhere. Three narrower type
 * forms that keep the field pinned to some instantiation of `PublicClient` itself
 * (chain generic fixed to `undefined`, to the bare `Chain` interface, or left at the
 * two-argument default) were tried first and proven, by the compiler, to fail
 * identically — the incompatibility lives in `getBlock`, a member this `Pick`
 * excludes entirely, not in the chain generic. A client built for ANY chain — Base
 * included — satisfies this shape, because it was never asked to promise anything
 * about `getBlock` in the first place.
 *
 * Still nothing here can carry a key, a mnemonic or a signer — narrowing
 * which READS are required only shrinks the surface, it does not add one.
 */
export type SnfPublicClient = Pick<
  PublicClient,
  | 'readContract'
  | 'multicall'
  | 'simulateContract'
  | 'estimateContractGas'
  | 'getBlockNumber'
  | 'getBalance'
  | 'chain'
>

/**
 * `createSnfClient` config and the client object shapes.
 *
 * `publicClient` is the partner's own — the SDK never constructs a transport, never
 * holds an RPC URL, and never receives a `WalletClient`. There is intentionally
 * no `mode` field: Legacy is discontinued workspace-wide (root CLAUDE.md, "Legacy —
 * DESCONTINUADO"), so a Legacy request is `INVALID_PARAMS`, never a toggle. And there
 * is no field of any name or shape that could carry a private key, mnemonic or signer
 * — making a signer unrepresentable in the type is a stronger guarantee than the
 * `local/no-signing-imports` lint rule alone (In the threat register).
 */
export interface SnfClientConfig {
  readonly chainId: SnfChainId
  readonly publicClient: SnfPublicClient
  readonly providers?: DataProviders
  readonly subgraph?: {
    readonly ttlMs?: number
    readonly inventoryTtlMs?: number
    readonly staleLagSeconds?: number
    readonly degradedLagSeconds?: number
    readonly breakerThreshold?: number
    readonly breakerCooldownMs?: number
  }
  readonly defaults?: {
    readonly slippageBps?: number
    readonly deadlineSeconds?: number
  }
}

/**
 * The internal context every domain function's first parameter is. Never exported as
 * part of the documented partner surface — `SnfClient` (the object `createSnfClient`
 * returns) is the entire documented API.
 */
export interface SnfClientContext {
  readonly config: SnfClientConfig
  readonly chain: SnfChainConfig
  readonly publicClient: SnfPublicClient
  readonly providers: DataProviders
  readonly transport: SubgraphTransport
  nextTxInvalidationVersion(): number
}

/**
 * The object `createSnfClient` returns — the ENTIRE documented public surface.
 * Thirteen methods plus `chainId`/`chain`. Free functions may exist internally as
 * this package's implementation, but a partner is only ever meant to call through this
 * object — `snf.quoteBuy(...)`, never a bare imported `quoteBuy(...)`.
 */
export interface SnfClient {
  readonly chainId: SnfChainId
  readonly chain: SnfChainConfig
  collection(address: `0x${string}`): Promise<CollectionInfo>
  poolInventory(pair: `0x${string}`): Promise<PoolInventory>
  quoteBuy(args: QuoteBuyArgs): Promise<Quote>
  quoteSell(args: QuoteSellArgs): Promise<Quote>
  quoteNftToNft(args: QuoteNftToNftArgs): Promise<Quote>
  quoteSwap(args: QuoteSwapArgs): Promise<Quote>
  estimateLadder(reserves: { readonly base: bigint; readonly wnft: bigint }, n: number): LadderResult
  buildBuy(args: BuildArgs): Promise<ExecutionPlan>
  buildSell(args: BuildArgs): Promise<ExecutionPlan>
  buildNftToNft(args: BuildArgs): Promise<ExecutionPlan>
  buildSwap(args: BuildArgs): Promise<ExecutionPlan>
  /** Synchronous by design — the logs are already on the receipt; no further RPC read
   * is needed to attribute items/fees. Takes `ReceiptLike` (a structural subset
   * of viem's `TransactionReceipt`, `receipt/receipt.types.ts`) rather than the full
   * type, so any receipt-shaped object from any source works. */
  parseReceipt(receipt: ReceiptLike): SwapReceipt
  describeError(e: unknown): SnfError
}
