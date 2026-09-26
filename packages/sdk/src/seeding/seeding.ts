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
 * Both bodies stay non-`async` and return via `Promise.reject` rather than an
 * `async function` with no `await` — the same reasoning this package's other stub
 * bodies already established (an `async` function with no `await` trips
 * `@typescript-eslint/require-await`, and a bare synchronous `throw` would make the
 * *call itself* throw before any `Promise` exists, breaking the common
 * `await expect(...).rejects.toThrow()` idiom). Validating BEFORE that rejection
 * still has to happen without ever throwing synchronously, so a malformed address is
 * caught and re-wrapped into the same rejected `Promise` instead.
 */

function notLive(ctx: SnfClientContext, collection: `0x${string}`, surface: 'seeding' | 'attestation'): SnfError {
  return new SnfError('PRODUCT_NOT_LIVE', 'Seeding reads are not live on this chain yet.', {
    details: { chainId: ctx.chain.chainId, collection, surface },
  })
}

export function seeding(ctx: SnfClientContext, collection: `0x${string}`): Promise<SeedingInfo> {
  let address: `0x${string}`
  try {
    address = assertAddress(collection, 'collection')
  } catch (e) {
    return Promise.reject(e)
  }
  return Promise.reject(notLive(ctx, address, 'seeding'))
}

export function attestation(ctx: SnfClientContext, collection: `0x${string}`): Promise<SeedingAttestation> {
  let address: `0x${string}`
  try {
    address = assertAddress(collection, 'collection')
  } catch (e) {
    return Promise.reject(e)
  }
  return Promise.reject(notLive(ctx, address, 'attestation'))
}
