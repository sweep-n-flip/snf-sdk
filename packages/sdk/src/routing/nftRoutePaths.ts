import type {
  BuildNftRoutePathArgs,
  BuildWnftRoutePathArgs,
  PoolRef,
  RoutePath,
  WrapperSide,
} from './routing.types'
import type { TokenRef } from '../types/amount.types'

/**
 * Pure NFT swap route-path builders (REQ-SDK-14, R10; 54-SPEC.md). Ported from
 * `snf-client/src/lib/swap/nftRoutePaths.ts` — see `snf-54-07-SUMMARY.md` for the
 * rename table (the SDK's route-path shape is `{ collection, baseToken, side }`
 * rather than the UI-hook-flag inputs `snf-client`'s three builders read, since the
 * SDK has no `useSwapRoutingFlags` hook upstream deriving those flags).
 *
 * COLLECTION, NEVER THE WRAPPER
 * ------------------------------
 * `buildNftRoutePath` places the **collection** address in `path[]`, never the
 * wrapper — the Router resolves the wrapper internally via `Factory.getWrapper`
 * for every `*Collection` entry point
 * (`snf-contracts/contracts/periphery/UniswapV2Router01Collection.sol:200-330`).
 * Writing a wrapper address into a `*Collection` path is a silent wrong-path bug:
 * the Router would either revert (no pair at that address) or, worse, resolve to
 * an unrelated pair if the wrapper happens to also be a valid pool token elsewhere.
 *
 * `buildWnftRoutePath` is the different, fungible-leg case: the user is trading the
 * wrapper token ITSELF (a fractional wNFT amount), so that path DOES carry the
 * wrapper address — there is no `*Collection` substitution to rely on.
 *
 * THE WRAPPER SIDE IS NEVER ASSUMED
 * -----------------------------------
 * `resolveWrapperSide` derives which pair slot is the wrapper from `discrete0`/
 * `discrete1` (subgraph reads) or from an address comparison against `baseToken`
 * (on-chain reads) — never from an index. Root `CLAUDE.md`, "What NOT to Do": "Don't
 * assume NFT wrapper is always token1 — it can be token0 (check `discrete0`/
 * `discrete1` or `nftWrapperAddress`)".
 */

/**
 * Which pair slot (`token0`/`token1`) holds the NFT wrapper, plus the resolved base
 * token. Prefers the subgraph's own `discrete0`/`discrete1` flags when present;
 * otherwise derives the wrapper side from whichever slot's address does NOT match
 * `pool.baseToken.address` (a `PoolRef`'s `baseToken.address` is always the pool's
 * concrete on-chain quote-side address — see `routing.types.ts`).
 */
export function resolveWrapperSide(
  pool: PoolRef,
): { readonly wrapperIsToken0: boolean; readonly wrapperSide: WrapperSide; readonly baseToken: TokenRef } {
  const wrapperIsToken0 =
    pool.discrete0 !== undefined || pool.discrete1 !== undefined
      ? pool.discrete0 === true
      : pool.token0.toLowerCase() !== pool.baseToken.address?.toLowerCase()

  return {
    wrapperIsToken0,
    wrapperSide: wrapperIsToken0 ? 'token0' : 'token1',
    baseToken: pool.baseToken,
  }
}

/**
 * The `address[]` a `*Collection` Router entry point expects: `[baseToken,
 * collection]` for a buy, `[collection, baseToken]` for a sell. Carries the
 * collection address, never the wrapper — see this module's header.
 */
export function buildNftRoutePath(args: BuildNftRoutePathArgs): RoutePath {
  const { collection, baseToken, side } = args
  return side === 'buy' ? [baseToken, collection] : [collection, baseToken]
}

/**
 * The `address[]` a plain (non-`Collection`) Router entry point expects when the
 * user trades the wrapper token itself: `[baseToken, wrapper]` for a buy,
 * `[wrapper, baseToken]` for a sell. Unlike `buildNftRoutePath`, this path DOES
 * carry the wrapper address — there is no Router-side substitution for a fungible
 * leg.
 */
export function buildWnftRoutePath(args: BuildWnftRoutePathArgs): RoutePath {
  const { wrapper, baseToken, side } = args
  return side === 'buy' ? [baseToken, wrapper] : [wrapper, baseToken]
}
