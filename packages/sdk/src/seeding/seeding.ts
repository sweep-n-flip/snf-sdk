import { SnfError } from '../errors'
import type { SnfClientContext } from '../types/client.types'
import type { SeedingAttestation, SeedingInfo } from '../types/seeding.types'

/**
 * Stubs — these two bodies are replaced by their implementation; the signatures below
 * are fixed (see the plan's Interfaces section) and do not change when the bodies do.
 * Both return a rejected `Promise` rather than throwing synchronously, so a caller's
 * `await` always sees a rejection, never a synchronous throw before any `Promise`
 * exists. Neither reads a contract or an off-chain service yet — see this file's own
 * header once implemented for why, before that point, every chain answers the same way.
 */
export function seeding(ctx: SnfClientContext, collection: `0x${string}`): Promise<SeedingInfo> {
  void ctx
  void collection
  return Promise.reject(new SnfError('UNKNOWN', 'seeding is not implemented yet'))
}

export function attestation(ctx: SnfClientContext, collection: `0x${string}`): Promise<SeedingAttestation> {
  void ctx
  void collection
  return Promise.reject(new SnfError('UNKNOWN', 'attestation is not implemented yet'))
}
