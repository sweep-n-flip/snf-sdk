import { createElement, type ReactElement, type ReactNode } from 'react'
import { afterEach } from 'vitest'
import { cleanup, render, type RenderResult } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SnfProvider, type SnfProviderProps } from '@sweepnflip/sdk-react'
import type {
  Amount,
  Bounds,
  CollectionInfo,
  ExecutionPlan,
  PoolInventory,
  Quote,
  SnfClient,
  Step,
  StepKind,
  UnsignedTx,
} from '@sweepnflip/sdk'

/**
 * jsdom global setup (mirrors `packages/sdk-react/test/setup.ts`). `@testing-library/
 * react`'s own `cleanup` unmounts every tree rendered by `render` after each test —
 * without this, a component left mounted by one test would leak into the next test's
 * DOM and query cache, producing flaky cross-test failures unrelated to the assertion
 * actually under test.
 */
afterEach(() => {
  cleanup()
})

/** A fresh `QueryClient` per test — `retry: false` so a deliberately-rejecting stub
 * client fails fast instead of react-query's default 3-retry backoff, `gcTime: 0` so
 * no state survives between tests even without a full remount. Identical shape to
 * `sdk-react`'s own `createTestQueryClient`. */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
}

/** A minimal structural stand-in for viem's `PublicClient` — `SnfProvider` only needs
 * it to type-check when no `client` override is given; no test in this suite lets a
 * real RPC call reach it (every test passes a stubbed `SnfClient` via the `client`
 * prop instead). Never actually called — mirrors `sdk-react`'s own
 * `makeStubPublicClient`. */
const STUB_PUBLIC_CLIENT = {
  readContract: () => Promise.reject(new Error('stub publicClient: readContract should never be called')),
  multicall: () => Promise.reject(new Error('stub publicClient: multicall should never be called')),
} as unknown as SnfProviderProps['publicClient']

export interface RenderWithSnfOptions {
  readonly client: SnfClient
  readonly chainId?: SnfProviderProps['chainId']
  readonly queryClient?: QueryClient
}

/**
 * Renders a COMPONENT tree (not a hook — this is `render`, where `sdk-react/test/
 * setup.ts`'s `renderWithSnf` wraps `renderHook`) under
 * `<QueryClientProvider><SnfProvider client={stub}>` — the shared harness every
 * widgets test file imports. Always passes `client` (a stubbed `SnfClient`, `vi.fn()`
 * methods) rather than `publicClient`/`providers`, so `SnfProvider` never actually
 * calls `createSnfClient` — the core's own construction-time validation and transport
 * are already covered by `packages/sdk`'s own test suite; this harness only needs the
 * REACT layer wired.
 *
 * **wagmi-mock pattern for any test exercising `useSnfCheckout`-backed UI** (not used
 * by this plan; documented here for plans 04/05/08 to find): `vi.mock('wagmi', () => ({
 * useSendTransaction: () => ({ sendTransactionAsync: mocks.sendTransactionAsync, reset:
 * mocks.reset }), useWaitForTransactionReceipt: () => mocks.receipt }))` with `mocks`
 * built via `vi.hoisted(...)`, declared at the TOP of each test file that needs it —
 * vitest hoists `vi.mock` per-file, so it cannot live in this shared file and apply
 * everywhere (not every widgets test needs a fake wallet). `packages/sdk-react/test/
 * useSnfCheckout.test.tsx` lines 1-42 are the copy-exact reference.
 */
export function renderWithSnf(ui: ReactElement, opts: RenderWithSnfOptions): RenderResult & { readonly queryClient: QueryClient } {
  const queryClient = opts.queryClient ?? createTestQueryClient()
  const chainId = opts.chainId ?? opts.client.chainId

  function Wrapper({ children }: { readonly children: ReactNode }) {
    return createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(SnfProvider, { chainId, publicClient: STUB_PUBLIC_CLIENT, client: opts.client }, children),
    )
  }

  const result = render(ui, { wrapper: Wrapper })
  return { ...result, queryClient }
}

// ---------------------------------------------------------------------------------
// Fixture builders — real, complete `Amount`/`Quote`/`PoolInventory`/`CollectionInfo`/
// `ExecutionPlan` values, copied field-for-field from `packages/sdk-react/test/
// hooks.test.tsx` and `packages/sdk-react/test/useSnfCheckout.test.tsx` (the shapes
// every later widgets plan's tests build on, so they must be real, not partial
// stand-ins).
// ---------------------------------------------------------------------------------

/** Copied field-for-field from `hooks.test.tsx`'s local `amount(value)`. */
export function fakeAmount(value: bigint): Amount {
  return { value, formatted: value.toString(), symbol: 'ETH', decimals: 18 }
}

/** Copied field-for-field from `hooks.test.tsx`'s local `fakeQuote()`. */
export function fakeQuote(): Quote {
  return {
    side: 'buy',
    chainId: 8453,
    legs: [],
    fees: {
      pool: { bps: 200, note: 'included in curve' },
      marketplace: { ...fakeAmount(0n), bps: 250 },
      royalty: { ...fakeAmount(0n), bps: 0, capApplied: false },
    },
    priceImpact: 0,
    deliverable: 1,
    bestEffort: false,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    reconciled: true,
  }
}

/** Copied field-for-field from `hooks.test.tsx`'s local `fakePoolInventory()`. */
export function fakePoolInventory(): PoolInventory {
  return {
    tokenIds: [],
    availableCount: 0,
    asOfBlock: 1n,
    lagSeconds: 0,
    stale: false,
    source: 'enumerable',
    truncated: false,
    warnings: [],
  }
}

/** Copied field-for-field from `hooks.test.tsx`'s local `fakeCollectionInfo()`. */
export function fakeCollectionInfo(): CollectionInfo {
  return {
    address: '0xcccccccccccccccccccccccccccccccccccccc',
    wrapper: '0xdddddddddddddddddddddddddddddddddddddd',
    pools: [],
    labels: { name: 'Fake Collection', symbol: 'FAKE' },
    royalty: {
      bps: 0,
      receiver: null,
      capBps: 0,
      effectiveBpsWhenCapped: 0,
      basis: 'collection-default',
      unpayableReceiver: false,
      warnings: [],
      probeFailed: false,
    },
    redemptionLocked: false,
    wrapperVerified: 'match',
  }
}

/** Copied field-for-field from `useSnfCheckout.test.tsx`'s local `fakeTx()`. */
function fakeTx(to: `0x${string}` = '0x0000000000000000000000000000000000000001'): UnsignedTx {
  return { to, data: '0x', value: 0n, chainId: 8453 }
}

/** Copied field-for-field from `useSnfCheckout.test.tsx`'s local `fakeBounds()`. */
function fakeBounds(): Bounds {
  return { slippageBps: 100, deadline: 0n }
}

/** Copied field-for-field from `useSnfCheckout.test.tsx`'s local `fakeStep(kind)`. */
function fakeStep(kind: StepKind): Step {
  return { kind, label: kind, tx: fakeTx(), approvals: [], bounds: fakeBounds(), quote: fakeQuote() }
}

/** Copied field-for-field from `useSnfCheckout.test.tsx`'s local `fakePlan(kinds)`. */
export function fakePlan(kinds: readonly StepKind[]): ExecutionPlan {
  return {
    chainId: 8453,
    steps: kinds.map(fakeStep),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    preflight: () => Promise.resolve({ ok: true, blockNumber: 1n, checked: [] }),
  }
}
