import { createElement, type ReactNode } from 'react'
import { afterEach } from 'vitest'
import { cleanup, renderHook, type RenderHookResult } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SnfClient } from '@sweepnflip/sdk'
import { SnfProvider, type SnfProviderProps } from '../src/context'

/**
 * jsdom global setup (R18; 54-SPEC.md). `@testing-library/react`'s own `cleanup`
 * unmounts every tree rendered by `render`/`renderHook` after each test — without
 * this, a component left mounted by one test (e.g. deliberately, to assert an
 * unmount-safety behavior mid-test) would leak into the next test's DOM and query
 * cache, producing flaky cross-test failures that have nothing to do with the
 * assertion actually under test.
 */
afterEach(() => {
  cleanup()
})

/** A fresh `QueryClient` per test — `retry: false` so a deliberately-rejecting stub
 * client fails fast instead of react-query's default 3-retry backoff, `gcTime: 0` so
 * no state survives between tests even without a full remount (react-query testing
 * guidance, verified via Context7 this session). */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
}

/** A minimal structural stand-in for viem's `PublicClient` — `SnfProvider` only
 * needs it to type-check and (when no `client` override is given) to pass
 * `createSnfClient`'s own `readContract`/`multicall`-presence check at construction;
 * no test in this suite lets a real RPC call reach it (every test passes a stubbed
 * `SnfClient` via the `client` prop instead, per this plan's own instruction: "no
 * live RPC/wallet"). */
export function makeStubPublicClient(): SnfProviderProps['publicClient'] {
  return {
    readContract: () => Promise.reject(new Error('stub publicClient: readContract should never be called')),
    multicall: () => Promise.reject(new Error('stub publicClient: multicall should never be called')),
  } as unknown as SnfProviderProps['publicClient']
}

export interface RenderWithSnfOptions {
  readonly client: SnfClient
  readonly chainId?: SnfProviderProps['chainId']
  readonly queryClient?: QueryClient
}

/**
 * Renders a hook under `<QueryClientProvider><SnfProvider client={stub}>` — the
 * shared harness every test in `hooks.test.tsx` and `useSnfCheckout.test.tsx` uses.
 * Always passes `client` (a stubbed `SnfClient`, `vi.fn()` methods) rather than
 * `publicClient`/`providers`, so `SnfProvider` never actually calls
 * `createSnfClient` — `packages/sdk`'s own construction-time validation and
 * transport are already covered by `packages/sdk/test/client.test.ts`; this suite
 * tests the REACT layer's caching/dispatch behaviour, not the core's correctness
 * (mirrors this plan's own Task 3 instruction).
 */
export function renderWithSnf<T>(
  callback: () => T,
  options: RenderWithSnfOptions,
): RenderHookResult<T, unknown> & { readonly queryClient: QueryClient } {
  const queryClient = options.queryClient ?? createTestQueryClient()
  const publicClient = makeStubPublicClient()
  const chainId = options.chainId ?? 8453

  function Wrapper({ children }: { readonly children: ReactNode }) {
    return createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(SnfProvider, { chainId, publicClient, client: options.client }, children),
    )
  }

  const result = renderHook(callback, { wrapper: Wrapper })
  return { ...result, queryClient }
}
