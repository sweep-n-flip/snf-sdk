import type { DirectOnlyResult, EvaluateDirectOnlyArgs, IsDirectOnlyArgs } from './routing.types'
import type { TokenRef } from '../types/amount.types'

/**
 * Gate 69.5 ported (REQ-SDK-14, R10; 54-SPEC.md). Ported from
 * `snf-client/src/lib/swap/directOnlyRouting.ts` — see `snf-54-07-SUMMARY.md` for
 * the rename table. Original context: the V2 delegate on Robinhood Chain holds
 * ~1e-9 of the 40 founder stock tokens, so any `[WETH, <stock>, collection]` hop
 * reverts or returns a garbage quote. A stock token may only back a DIRECT pool with
 * a collection — the two-entry path `[<stock>, collection]` / `[collection,
 * <stock>]` — and must never be composed into a longer fungible leg.
 *
 * A blocked route is an explicit typed failure with an alternative, never a
 * silently empty quote (prohibition #9). `filterViablePayTokens` never returns an
 * empty array when at least one candidate pool exists: every candidate already has
 * an on-chain pair with the collection, so its base token is always viable when
 * paid DIRECTLY (the 2-entry path Gate 69.5 never restricts) — direct-only status
 * only forbids using that base as an INTERMEDIATE leg for a different payToken,
 * which `isDirectOnly` alone decides.
 */

const DIRECT_PAIR_PATH_LENGTH = 2

/**
 * True when `path` would trade a direct-only-base token as a fungible LEG rather
 * than as the direct counterpart of the collection — the doomed construction Gate
 * 69.5 forbids. A two-entry path (the direct pair) is always allowed, whichever
 * token occupies it; any longer path containing one of `directOnlyBaseAddresses` is
 * forbidden, whatever slot it occupies (mirrors
 * `pathHasDirectOnlyFungibleLeg`/CR-01's structural, path-based guard).
 */
export function isDirectOnly(args: IsDirectOnlyArgs): boolean {
  const { path, directOnlyBaseAddresses } = args
  if (path.length <= DIRECT_PAIR_PATH_LENGTH || directOnlyBaseAddresses.length === 0) return false
  const directOnly = new Set(directOnlyBaseAddresses.map((address) => address.toLowerCase()))
  return path.some((address) => directOnly.has(address.toLowerCase()))
}

/**
 * The base tokens of every candidate pool — always the full set, never filtered
 * down to zero when `candidates` is non-empty. See this module's header for why a
 * direct-only base is still a viable PAY token (just not a viable intermediate hop).
 */
export function filterViablePayTokens(args: {
  readonly candidates: readonly { readonly baseToken: TokenRef }[]
}): readonly TokenRef[] {
  return args.candidates.map((pool) => pool.baseToken)
}

/**
 * Combines `isDirectOnly` + `filterViablePayTokens` into the one result
 * `routeBlock.ts` needs: whether THIS path is blocked, and what a caller could pay
 * with instead.
 */
export function evaluateDirectOnly(args: EvaluateDirectOnlyArgs): DirectOnlyResult {
  return {
    blocked: isDirectOnly({ path: args.path, directOnlyBaseAddresses: args.directOnlyBaseAddresses }),
    viablePayTokens: filterViablePayTokens({ candidates: args.candidates }),
  }
}
