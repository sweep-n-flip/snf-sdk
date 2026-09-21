import type { SnfClient } from '@sweepnflip/sdk'
import { useSnfContext } from '../context'

/**
 * Returns the active `<SnfProvider>`'s `SnfClient` — the escape hatch for a call that
 * has no dedicated `useSnf*` hook (e.g. `client.buildBuy(...)`, `client.estimateLadder
 * (...)`, `client.parseReceipt(...)` outside `useSnfCheckout`). Throws `SnfError
 * ('INVALID_PARAMS')` naming `<SnfProvider>` when called outside one
 * (`useSnfContext`'s own contract).
 */
export function useSnfClient(): SnfClient {
  return useSnfContext().client
}
