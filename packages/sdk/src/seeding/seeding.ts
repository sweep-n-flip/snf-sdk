import { assertAddress } from '../build/validate'
import { SnfError } from '../errors'
import type { SnfClientContext } from '../types/client.types'
import type { SeedingAttestation, SeedingInfo } from '../types/seeding.types'

/**
 * `seeding` / `attestation` — typed reads for a launch-seeding surface that is not
 * deployed or audited on any chain today. Both validate their `collection` argument
 * (a malformed address is `INVALID_PARAMS`, exactly like every other public method in
 * this package) and then reject with `PRODUCT_NOT_LIVE` on EVERY chain, uniformly —
 * make zero RPC calls, and this file imports nothing from `src/abis` and carries no
 * address literal. A partner can branch on `PRODUCT_NOT_LIVE` today; when that
 * surface is live and audited, both bodies gain the real reads without either
 * signature changing.
 *
 * Both bodies stay non-`async` — the same reasoning this package's other stub bodies
 * already established (an `async` function with no `await` trips
 * `@typescript-eslint/require-await`) — and validate/throw from inside a `.then`
 * callback rather than calling `Promise.reject` directly with a caught, statically
 * `unknown` value (which `@typescript-eslint/prefer-promise-reject-errors` correctly
 * refuses to accept without a cast). A `throw` inside a `.then` callback rejects the
 * resulting `Promise` exactly like a `Promise.reject` call would — a caller's `await`
 * always sees a rejection, never a synchronous throw before any `Promise` exists,
 * whether the failure is the validation or the `PRODUCT_NOT_LIVE` result itself.
 */

function notLive(ctx: SnfClientContext, collection: `0x${string}`, surface: 'seeding' | 'attestation'): never {
  throw new SnfError('PRODUCT_NOT_LIVE', 'Seeding reads are not live on this chain yet.', {
    details: { chainId: ctx.chain.chainId, collection, surface },
  })
}

export function seeding(ctx: SnfClientContext, collection: `0x${string}`): Promise<SeedingInfo> {
  return Promise.resolve().then(() => notLive(ctx, assertAddress(collection, 'collection'), 'seeding'))
}

export function attestation(ctx: SnfClientContext, collection: `0x${string}`): Promise<SeedingAttestation> {
  return Promise.resolve().then(() => notLive(ctx, assertAddress(collection, 'collection'), 'attestation'))
}
