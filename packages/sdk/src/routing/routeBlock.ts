import { evaluateDirectOnly } from './directOnlyRouting'
import type { EvaluateRouteBlockArgs, RouteBlockCodeMap, RouteBlockResult } from './routing.types'

/**
 * `evaluateRouteBlock` — the typed reason a route is unavailable. Ported from the
 * production AMM client's routing-block logic. The production client's version only
 * ever distinguishes the two Gate-69.5 reasons (`token-not-routable`/`path-not-routable`);
 * this SDK-level reduction generalises to the full `RouteBlockReason` union both quote
 * paths need (`different-base` for NFT×NFT, `no-pair`/`no-liquidity` for an absent quote).
 *
 * The lesson behind why this is a first-class return value, not `undefined`:
 * an absent path is ambiguous between "take the default route" and "there is no
 * transaction to send" — production consumers once read `undefined` as the former
 * and shipped a wrong-token dispatch. `evaluateRouteBlock` always returns an
 * explicit `blocked` boolean so a caller can never make that mistake.
 */

/**
 * Every `RouteBlockReason` maps to exactly one `SnfErrorCode` — `'unsupported-token'`
 * is the one validation-shaped reason (`INVALID_PARAMS`); every other reason means
 * "the request is valid, but no route exists" (`NO_ROUTE`). `Record<RouteBlockReason,
 * SnfErrorCode>` makes an incomplete map a `tsc` error, not just a runtime gap;
 * `test/routing/routeBlock.test.ts` also asserts this exhaustively at runtime over
 * `ROUTE_BLOCK_REASONS`.
 */
export const ROUTE_BLOCK_CODE: RouteBlockCodeMap = {
  'direct-only': 'NO_ROUTE',
  'no-pair': 'NO_ROUTE',
  'no-liquidity': 'NO_ROUTE',
  'different-base': 'NO_ROUTE',
  'unsupported-token': 'INVALID_PARAMS',
}

/**
 * Resolves the single most specific reason the requested route is blocked, or
 * `blocked: false` when it is routable. Order (most specific first):
 * 1. `unsupportedToken` — the caller already flagged an invalid token param.
 * 2. NFT×NFT `different-base` — the sell and buy legs price in different bases
 * (pools with different bases mean no route).
 * 3. `no-pair` — no candidate pool exists for the collection at all.
 * 4. `noLiquidity` — a candidate pool exists but is empty.
 * 5. `direct-only` — the resolved `path` composes a direct-only base into a
 * fungible leg (see `directOnlyRouting.ts`).
 * `viablePayTokens` is always populated from `candidates` (never empty when a
 * candidate exists), whether or not the route ends up blocked — a caller building a
 * `SnfError('NO_ROUTE').details.viablePayTokens` never has to re-derive it.
 */
export function evaluateRouteBlock(args: EvaluateRouteBlockArgs): RouteBlockResult {
  const { candidates, path, directOnlyBaseAddresses, unsupportedToken, noLiquidity, nftToNft } = args
  const { viablePayTokens } = evaluateDirectOnly({
    path: path ?? [],
    directOnlyBaseAddresses,
    candidates,
  })

  if (unsupportedToken) {
    return { blocked: true, reason: 'unsupported-token', viablePayTokens }
  }

  if (nftToNft && nftToNft.sellPoolBase.address !== nftToNft.buyPoolBase.address) {
    return { blocked: true, reason: 'different-base', viablePayTokens }
  }

  if (candidates.length === 0) {
    return { blocked: true, reason: 'no-pair', viablePayTokens }
  }

  if (noLiquidity) {
    return { blocked: true, reason: 'no-liquidity', viablePayTokens }
  }

  if (isPathDirectOnlyBlocked(path, directOnlyBaseAddresses)) {
    return { blocked: true, reason: 'direct-only', viablePayTokens }
  }

  return { blocked: false, viablePayTokens }
}

function isPathDirectOnlyBlocked(
  path: EvaluateRouteBlockArgs['path'],
  directOnlyBaseAddresses: EvaluateRouteBlockArgs['directOnlyBaseAddresses'],
): boolean {
  if (!path) return false
  return evaluateDirectOnly({ path, directOnlyBaseAddresses, candidates: [] }).blocked
}
