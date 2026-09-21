import type { Abi } from 'viem'

import { ERC721_ABI } from '../abis/ERC721'
import type { SnfClientContext } from '../types/client.types'

/**
 * The `ERC721Enumerable` fast path for `poolInventory` (R7, OD-SDK-3; 54-SPEC.md):
 * when a collection implements it, the pool's own holdings are readable directly from
 * the chain — fresher than any index and free of Goldsky's free-tier quota.
 */

export const ERC721_ENUMERABLE_INTERFACE_ID = '0x780e9d63' as const

/** Multicall3 has no formal per-call limit, but 200 keeps one call's calldata and
 * response comfortably bounded — the same discipline every caller-sized loop in this
 * package follows (T-54-59). Reported via `truncated`, never a silent cut. */
const MAX_ENUMERABLE_BATCH = 200

/** Loosely-typed multicall shape — see `collection/royalty.ts`'s identical
 * comment: viem's per-position tuple inference cannot type-check a batch built from a
 * `.map()`/`Array.from`-derived, variable-length array. */
interface Call {
  readonly address: `0x${string}`
  readonly abi: Abi
  readonly functionName: string
  readonly args: readonly unknown[]
}
type CallResult = { readonly status: 'success' | 'failure'; readonly result?: unknown }

export interface ReadEnumerableTokenIdsArgs {
  readonly collection: `0x${string}`
  /** The NFT holder to enumerate — the WERC721 **wrapper** contract, which is what
   * actually custodies every wrapped NFT (`WERC721.mint` transfers the NFT IN to the
   * wrapper, never to the pair). The pair only ever holds the wrapper's fungible
   * ERC-20 units. */
  readonly holder: `0x${string}`
  /** How many indices to read, typically `floor(reserveWnft / 1e18)` — capped
   * internally at `MAX_ENUMERABLE_BATCH`. */
  readonly balance: number
}

export interface ReadEnumerableTokenIdsResult {
  readonly tokenIds: readonly string[]
  readonly truncated: boolean
  readonly warnings: readonly string[]
}

/**
 * `tokenOfOwnerByIndex(holder, i)` for `i` in `[0, min(balance, 200))`, one
 * `multicall`, `allowFailure: true` — a single reverted slot (e.g. a race with a
 * concurrent burn between the reserve read and this call) is dropped with a warning,
 * never fails the whole read. Called ONLY after `supportsInterface(0x780e9d63)` has
 * confirmed `ERC721Enumerable` — `tokenOfOwnerByIndex` reverts outright otherwise, so
 * the probe is a precondition, not an optimisation.
 */
export async function readEnumerableTokenIds(
  ctx: SnfClientContext,
  args: ReadEnumerableTokenIdsArgs,
): Promise<ReadEnumerableTokenIdsResult> {
  const { collection, holder, balance } = args
  const truncated = balance > MAX_ENUMERABLE_BATCH
  const count = Math.max(0, Math.min(balance, MAX_ENUMERABLE_BATCH))
  if (count === 0) return { tokenIds: [], truncated, warnings: [] }

  const contracts: readonly Call[] = Array.from({ length: count }, (_unused, index) => ({
    address: collection,
    abi: ERC721_ABI,
    functionName: 'tokenOfOwnerByIndex',
    args: [holder, BigInt(index)],
  }))

  const results: readonly CallResult[] = await ctx.publicClient.multicall({
    contracts,
    allowFailure: true,
    multicallAddress: ctx.chain.multicall3,
    batchSize: 0,
  })

  const tokenIds: string[] = []
  const warnings: string[] = []
  results.forEach((r, index) => {
    if (r.status === 'success' && typeof r.result === 'bigint') {
      tokenIds.push(r.result.toString())
    } else {
      warnings.push(`tokenOfOwnerByIndex(${holder}, ${String(index)}) could not be read — skipped.`)
    }
  })
  if (truncated) {
    warnings.push(
      `Pool holds ${String(balance)} wrapped units — only the first ${String(MAX_ENUMERABLE_BATCH)} (MAX_ENUMERABLE_BATCH) were enumerated.`,
    )
  }
  return { tokenIds, truncated, warnings }
}
