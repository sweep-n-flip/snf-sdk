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
// interface's canonical home is now `transport/subgraph.types.ts` (plan 05), not a
// local declaration here. See this plan's SUMMARY, Deviations, for why plan 04's local
// `query<T>()`-only shape was replaced rather than kept alongside the real one.
export type { SubgraphTransport }

/**
 * `createSnfClient` config and the client object shapes (D-01–D-04; 54-SPEC.md R3).
 *
 * `publicClient` is the partner's own — the SDK never constructs a transport, never
 * holds an RPC URL, and never receives a `WalletClient` (D-04). There is intentionally
 * no `mode` field: Legacy is discontinued workspace-wide (root CLAUDE.md, "Legacy —
 * DESCONTINUADO"), so a Legacy request is `INVALID_PARAMS`, never a toggle. And there
 * is no field of any name or shape that could carry a private key, mnemonic or signer
 * — making a signer unrepresentable in the type is a stronger guarantee than the
 * `local/no-signing-imports` lint rule alone (T-54-17 in the threat register).
 */
export interface SnfClientConfig {
  readonly chainId: SnfChainId
  readonly publicClient: PublicClient
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
 * returns) is the entire documented API (D-01).
 */
export interface SnfClientContext {
  readonly config: SnfClientConfig
  readonly chain: SnfChainConfig
  readonly publicClient: PublicClient
  readonly providers: DataProviders
  readonly transport: SubgraphTransport
  nextTxInvalidationVersion(): number
}

/**
 * The object `createSnfClient` returns — the ENTIRE documented public surface (D-01).
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
   * is needed to attribute items/fees (R16). Takes `ReceiptLike` (a structural subset
   * of viem's `TransactionReceipt`, `receipt/receipt.types.ts`) rather than the full
   * type, so any receipt-shaped object from any source works. */
  parseReceipt(receipt: ReceiptLike): SwapReceipt
  describeError(e: unknown): SnfError
}
