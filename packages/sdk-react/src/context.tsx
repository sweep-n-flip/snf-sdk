import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { createSnfClient, SnfError, type SnfClient, type SnfClientConfig } from '@sweepnflip/sdk'

/**
 * `SnfProvider` + `useSnfContext` — holds one `SnfClient` per chain and the instance's
 * `txInvalidationVersion` (R18; 54-SPEC.md). This is the adapter's own React state,
 * separate from `SnfClientContext.nextTxInvalidationVersion` (the core's internal,
 * per-receipt counter that `parseReceipt` bumps and returns on `SwapReceipt` — see
 * `packages/sdk/src/client.ts`): the CORE counter proves a receipt's own
 * monotonicity to a caller who reads `SwapReceipt.txInvalidationVersion` directly;
 * THIS counter is what react-query's cache keys are built from (`queryKeys.ts`), so a
 * completed transaction busts every query key in this React tree, not just the
 * core's own internal bookkeeping. `useSnfCheckout` (plan 16 Task 2) is the only
 * caller of `bumpInvalidation` — on a checkout's final success, not on every leg's
 * receipt.
 */

export interface SnfContextValue {
  readonly client: SnfClient
  readonly chainId: SnfClient['chainId']
  /** Strictly increasing per `<SnfProvider>` instance — baked into every
   * `snfQueryKeys.*` entry so a bump refetches every collection/inventory/quote query
   * mounted under this provider (R18). */
  readonly txInvalidationVersion: number
  readonly bumpInvalidation: () => void
}

const SnfContext = createContext<SnfContextValue | null>(null)

export interface SnfProviderProps {
  readonly chainId: SnfClientConfig['chainId']
  readonly publicClient: SnfClientConfig['publicClient']
  readonly providers?: SnfClientConfig['providers']
  /**
   * Pass an already-built `SnfClient` instead of `publicClient`/`providers` — e.g. a
   * partner who constructed one with config this provider doesn't expose, or who
   * wants to share ONE client instance across two providers (their own choice to make;
   * R3's per-instance isolation is about what `createSnfClient` itself guarantees, not
   * about forcing a fresh instance on every provider mount). When set, `chainId` is
   * read from `client.chainId` and `publicClient`/`providers` are ignored.
   */
  readonly client?: SnfClient
  /** Optional so `createElement(SnfProvider, props, children)` (the third-argument
   * form every non-JSX call site — e.g. `test/setup.ts`'s `renderWithSnf` — uses)
   * type-checks; every real JSX `<SnfProvider>…</SnfProvider>` usage always supplies
   * it in practice. */
  readonly children?: ReactNode
}

/**
 * Mounts one `SnfClient` (memoized on `chainId`/`publicClient`/`providers`/`client`
 * identity — never recreated on every render) and exposes it, plus this provider's own
 * `txInvalidationVersion` counter, to every `useSnf*` hook underneath. Mounting two
 * `SnfProvider`s for two chains is supported and is exactly what R3's isolation
 * guarantees at the client level — each provider's `SnfClient` shares no transport
 * cache, breaker state, or invalidation counter with the other (`test/client.test.ts`
 * in `packages/sdk` proves this at the core level; `test/hooks.test.tsx`'s per-chain
 * isolation case proves it holds through this context and into react-query's own
 * cache, since `chainId` is baked into every query key).
 */
export function SnfProvider(props: SnfProviderProps): ReactNode {
  const { chainId, publicClient, providers, client: clientProp, children } = props

  const client = useMemo<SnfClient>(
    () =>
      clientProp ??
      // `exactOptionalPropertyTypes: true` forbids `providers: undefined` as an
      // explicit value (matches `packages/sdk/src/checkout/reducer.ts`'s own
      // `withoutError` doctrine) — the key must be ABSENT, not present-with-undefined,
      // when the caller didn't pass one.
      createSnfClient(providers === undefined ? { chainId, publicClient } : { chainId, publicClient, providers }),
    [clientProp, chainId, publicClient, providers],
  )

  const [txInvalidationVersion, setTxInvalidationVersion] = useState(0)
  const bumpInvalidation = useCallback(() => setTxInvalidationVersion((v) => v + 1), [])

  const value = useMemo<SnfContextValue>(
    () => ({ client, chainId: client.chainId, txInvalidationVersion, bumpInvalidation }),
    [client, txInvalidationVersion, bumpInvalidation],
  )

  return <SnfContext.Provider value={value}>{children}</SnfContext.Provider>
}

/** Throws a clear `SnfError('INVALID_PARAMS')` naming `<SnfProvider>` when called
 * outside one — every `useSnf*` hook (including `useSnfClient`) goes through this. */
export function useSnfContext(): SnfContextValue {
  const ctx = useContext(SnfContext)
  if (ctx === null) {
    throw new SnfError(
      'INVALID_PARAMS',
      'useSnfClient (and every other useSnf* hook) must be used within an <SnfProvider>.',
      { details: { field: 'SnfProvider' } },
    )
  }
  return ctx
}
