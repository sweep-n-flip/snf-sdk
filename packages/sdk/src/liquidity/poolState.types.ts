import type { TokenRef } from '../types/amount.types'

/**
 * Internal pool-state shapes `poolState.ts`'s two loaders return — not exported from
 * `src/index.ts`, not part of the public types barrel. Plans 04-06 (add/create,
 * remove, seed) compose these; a partner never sees them directly.
 */

/** The full on-chain state needed to quote/build a DEPOSIT (add, create, seed) —
 * `wrapper`/`pair` are `null` exactly when the deposit itself would create them. */
export interface DepositPoolState {
  readonly blockNumber: bigint
  readonly collection: `0x${string}`
  /** `null`: no wrapper yet — the Router's `_getWrapper` creates it inline. */
  readonly wrapper: `0x${string}` | null
  /** `null`: no pair yet — the Router's `_addLiquidity` creates it inline. */
  readonly pair: `0x${string}` | null
  /** The pool's real base token — its address is the actual base, never `null`, even
   * for a native pool (`address === ctx.chain.quoteToken` in that case). */
  readonly baseToken: TokenRef
  readonly isNative: boolean
  /** True when the ERC-20 base is itself some OTHER collection's wrapper —
   * `Factory.getCollection(base) != address(0)`. Display/warning signal only. */
  readonly baseIsWrapper: boolean
  /** `null` while the pair does not exist yet — there is no reserve ordering to
   * report. Never assumed from an index; see `resolveWrapperSide`. */
  readonly wrapperIsToken0: boolean | null
  /** `0n`/`0n` when there is no pair yet. */
  readonly reserves: { readonly base: bigint; readonly wnft: bigint }
  /** The PAIR's own token balances — not the cached `getReserves` values. `Pair.mint`
   * counts `balance - reserve` (not read by this loader; exposed here so a build
   * function that needs it never has to re-derive it from a second read). `0n`/`0n`
   * when there is no pair yet. */
  readonly balances: { readonly base: bigint; readonly wnft: bigint }
  readonly totalSupply: bigint
  readonly feeTo: `0x${string}`
}

/** The full on-chain state needed to quote/build a WITHDRAWAL from an existing,
 * caller-identified pair. Every field is populated — a withdrawal target always
 * already exists (its wrapper/pair cannot be `null`, unlike a deposit target). */
export interface PairPoolState {
  readonly blockNumber: bigint
  readonly pair: `0x${string}`
  readonly collection: `0x${string}`
  readonly wrapper: `0x${string}`
  readonly baseToken: TokenRef
  readonly isNative: boolean
  readonly wrapperIsToken0: boolean
  readonly reserves: { readonly base: bigint; readonly wnft: bigint }
  readonly balances: { readonly base: bigint; readonly wnft: bigint }
  readonly totalSupply: bigint
  readonly feeTo: `0x${string}`
  /** Present only when `owner` was passed to `loadPairState`. */
  readonly ownerLp?: bigint
}
