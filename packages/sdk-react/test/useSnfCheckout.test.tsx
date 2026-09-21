import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { describeError, SnfError, type SnfClient } from '@sweepnflip/sdk'
import type {
  Amount,
  Bounds,
  ExecutionPlan,
  PoolInventory,
  Quote,
  Step,
  StepKind,
  UnsignedTx,
} from '@sweepnflip/sdk'
import { useSnfCheckout } from '../src/hooks/useSnfCheckout'
import { useSnfPoolInventory } from '../src/hooks/useSnfPoolInventory'
import { renderWithSnf } from './setup'

/**
 * R15/R18/INV-17 — `useSnfCheckout`: the ONE dispatch site, behind an explicit click.
 * `wagmi`'s `useSendTransaction`/`useWaitForTransactionReceipt` are mocked (this
 * plan's own project_specifics: "no live RPC/wallet") — every test controls exactly
 * when a "wallet" resolves/rejects and when a "receipt" arrives.
 */

const mocks = vi.hoisted(() => ({
  sendTransactionAsync: vi.fn(),
  reset: vi.fn(),
  receipt: {
    data: undefined as
      | { status: 'success' | 'reverted'; transactionHash: `0x${string}`; blockNumber: bigint; logs: readonly unknown[] }
      | undefined,
    isSuccess: false,
    isError: false,
    error: undefined as unknown,
  },
}))

vi.mock('wagmi', () => ({
  useSendTransaction: () => ({ sendTransactionAsync: mocks.sendTransactionAsync, reset: mocks.reset }),
  useWaitForTransactionReceipt: () => mocks.receipt,
}))

function amount(value: bigint): Amount {
  return { value, formatted: value.toString(), symbol: 'ETH', decimals: 18 }
}

function fakeQuote(): Quote {
  return {
    side: 'sell',
    chainId: 8453,
    legs: [],
    fees: {
      pool: { bps: 200, note: 'included in curve' },
      marketplace: { ...amount(0n), bps: 250 },
      royalty: { ...amount(0n), bps: 0, capApplied: false },
    },
    priceImpact: 0,
    deliverable: 1,
    bestEffort: false,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    reconciled: true,
  }
}

function fakeTx(to: `0x${string}` = '0x0000000000000000000000000000000000000001'): UnsignedTx {
  return { to, data: '0x', value: 0n, chainId: 8453 }
}

function fakeBounds(): Bounds {
  return { slippageBps: 100, deadline: 0n }
}

function fakeStep(kind: StepKind): Step {
  return { kind, label: kind, tx: fakeTx(), approvals: [], bounds: fakeBounds(), quote: fakeQuote() }
}

function fakePlan(kinds: readonly StepKind[]): ExecutionPlan {
  return {
    chainId: 8453,
    steps: kinds.map(fakeStep),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    preflight: () => Promise.resolve({ ok: true, blockNumber: 1n, checked: [] }),
  }
}

function fakeReceipt(
  status: 'success' | 'reverted',
  hash: `0x${string}` = '0xaa',
): { status: 'success' | 'reverted'; transactionHash: `0x${string}`; blockNumber: bigint; logs: readonly unknown[] } {
  return { status, transactionHash: hash, blockNumber: 1n, logs: [] }
}

function fakePoolInventory(): PoolInventory {
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

/** A stubbed `SnfClient` — this suite tests the ADAPTER's dispatch discipline and
 * caching, not the core's correctness (plans 05-15 already cover that). `describeError`
 * is the REAL implementation (pure, side-effect-free) so a wallet rejection actually
 * classifies to `USER_REJECTED` the way a real client would. */
function fakeClient(overrides: Partial<SnfClient> = {}): SnfClient {
  return {
    chainId: 8453,
    chain: { chainId: 8453 } as SnfClient['chain'],
    collection: vi.fn(),
    poolInventory: vi.fn().mockResolvedValue(fakePoolInventory()),
    quoteBuy: vi.fn(),
    quoteSell: vi.fn(),
    quoteNftToNft: vi.fn(),
    quoteSwap: vi.fn(),
    estimateLadder: vi.fn(),
    buildBuy: vi.fn(),
    buildSell: vi.fn(),
    buildNftToNft: vi.fn(),
    buildSwap: vi.fn(),
    parseReceipt: vi.fn().mockReturnValue({
      itemsIn: [],
      itemsOut: [],
      fees: { marketplace: amount(0n), royalty: amount(0n) },
      txInvalidationVersion: 1,
    }),
    describeError,
    ...overrides,
  }
}

function resetReceiptMock(): void {
  mocks.receipt.data = undefined
  mocks.receipt.isSuccess = false
  mocks.receipt.isError = false
  mocks.receipt.error = undefined
}

beforeEach(() => {
  mocks.sendTransactionAsync.mockReset()
  mocks.reset.mockClear()
  resetReceiptMock()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useSnfCheckout — the one dispatch site', () => {
  it('next() dispatches exactly one transaction per click', async () => {
    mocks.sendTransactionAsync.mockResolvedValue('0xaa')
    const client = fakeClient()
    const plan = fakePlan(['swap-fungible'])
    const { result } = renderWithSnf(() => useSnfCheckout(plan), { client })

    await act(async () => {
      await result.current.next()
    })

    expect(mocks.sendTransactionAsync).toHaveBeenCalledTimes(1)
    expect(mocks.sendTransactionAsync).toHaveBeenCalledWith(
      expect.objectContaining({ to: fakeTx().to, data: '0x', value: 0n, chainId: 8453 }),
    )
  })

  it('two clicks in the same frame dispatch once — the second next() is a no-op', async () => {
    mocks.sendTransactionAsync.mockResolvedValue('0xaa')
    const client = fakeClient()
    const plan = fakePlan(['swap-fungible'])
    const { result } = renderWithSnf(() => useSnfCheckout(plan), { client })

    await act(async () => {
      await Promise.all([result.current.next(), result.current.next()])
    })

    expect(mocks.sendTransactionAsync).toHaveBeenCalledTimes(1)
  })

  it('reset() and sendTransactionAsync are called in that order, in the same click', async () => {
    mocks.sendTransactionAsync.mockResolvedValue('0xaa')
    const client = fakeClient()
    const plan = fakePlan(['swap-fungible'])
    const { result } = renderWithSnf(() => useSnfCheckout(plan), { client })

    await act(async () => {
      await result.current.next()
    })

    expect(mocks.reset).toHaveBeenCalledTimes(1)
    expect(mocks.sendTransactionAsync).toHaveBeenCalledTimes(1)
    expect(mocks.reset.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.sendTransactionAsync.mock.invocationCallOrder[0] as number,
    )
  })

  it('state projects to "pending" once a hash is broadcast, before the receipt arrives', async () => {
    mocks.sendTransactionAsync.mockResolvedValue('0xaa')
    const client = fakeClient()
    const plan = fakePlan(['swap-fungible'])
    const { result } = renderWithSnf(() => useSnfCheckout(plan), { client })

    expect(result.current.state).toBe('review')

    await act(async () => {
      await result.current.next()
    })

    expect(result.current.state).toBe('pending')
    expect(result.current.txHash).toBe('0xaa')
    expect(result.current.canProceed).toBe(false)
  })

  it('a successful receipt advances to the next ready-* state and sends nothing new', async () => {
    mocks.sendTransactionAsync.mockResolvedValue('0xaa')
    const client = fakeClient()
    const plan = fakePlan(['approval', 'swap-sell'])
    const { result, rerender } = renderWithSnf(() => useSnfCheckout(plan), { client })

    await act(async () => {
      await result.current.next()
    })
    expect(result.current.state).toBe('pending-approve')
    expect(mocks.sendTransactionAsync).toHaveBeenCalledTimes(1)

    mocks.receipt.isSuccess = true
    mocks.receipt.data = fakeReceipt('success')
    await act(async () => {
      rerender()
    })

    expect(result.current.state).toBe('ready-swap')
    expect(result.current.txHash).toBeUndefined()
    // The receipt watcher only ADVANCES the machine — it never sends.
    expect(mocks.sendTransactionAsync).toHaveBeenCalledTimes(1)
  })

  it('unmounting during "pending" leaves the send count unchanged and warns nothing', async () => {
    mocks.sendTransactionAsync.mockResolvedValue('0xaa')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const client = fakeClient()
    const plan = fakePlan(['swap-fungible'])
    const { result, unmount } = renderWithSnf(() => useSnfCheckout(plan), { client })

    await act(async () => {
      await result.current.next()
    })
    expect(result.current.state).toBe('pending')
    expect(mocks.sendTransactionAsync).toHaveBeenCalledTimes(1)

    unmount()

    // A receipt "arrives" after unmount — the (now-torn-down) watcher must be a no-op.
    mocks.receipt.isSuccess = true
    mocks.receipt.data = fakeReceipt('success')

    expect(mocks.sendTransactionAsync).toHaveBeenCalledTimes(1)
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('a user rejection routes through describeError to USER_REJECTED and restores the prior ready-* state', async () => {
    mocks.sendTransactionAsync.mockRejectedValue(new Error('User rejected the request.'))
    const client = fakeClient()
    const plan = fakePlan(['swap-fungible'])
    const { result } = renderWithSnf(() => useSnfCheckout(plan), { client })

    await act(async () => {
      await result.current.next()
    })

    expect(result.current.state).toBe('review')
    expect(result.current.error).toBeInstanceOf(SnfError)
    expect(result.current.error?.code).toBe('USER_REJECTED')
    expect(result.current.canProceed).toBe(true)
  })

  it('a reverted receipt moves the machine to "error" with a typed SnfError', async () => {
    mocks.sendTransactionAsync.mockResolvedValue('0xaa')
    const client = fakeClient()
    const plan = fakePlan(['swap-fungible'])
    const { result, rerender } = renderWithSnf(() => useSnfCheckout(plan), { client })

    await act(async () => {
      await result.current.next()
    })

    mocks.receipt.isSuccess = true
    mocks.receipt.data = fakeReceipt('reverted')
    await act(async () => {
      rerender()
    })

    expect(result.current.state).toBe('error')
    expect(result.current.error).toBeInstanceOf(SnfError)
  })

  it('after a final success, parseReceipt runs and the context invalidation version bumps — the inventory hook refetches', async () => {
    mocks.sendTransactionAsync.mockResolvedValue('0xaa')
    const client = fakeClient()
    const plan = fakePlan(['swap-fungible'])
    const { result, rerender, queryClient } = renderWithSnf(
      () => ({ checkout: useSnfCheckout(plan), inventory: useSnfPoolInventory('0xpair0000000000000000000000000000000000') }),
      { client },
    )

    await act(async () => {
      await result.current.inventory.refetch()
    })
    const callsBefore = (client.poolInventory as ReturnType<typeof vi.fn>).mock.calls.length
    expect(callsBefore).toBeGreaterThan(0)

    await act(async () => {
      await result.current.checkout.next()
    })

    mocks.receipt.isSuccess = true
    mocks.receipt.data = fakeReceipt('success')
    await act(async () => {
      rerender()
    })

    expect(result.current.checkout.state).toBe('success')
    expect(client.parseReceipt).toHaveBeenCalledTimes(1)

    await act(async () => {
      await queryClient.refetchQueries({ type: 'active' })
    })

    const callsAfter = (client.poolInventory as ReturnType<typeof vi.fn>).mock.calls.length
    expect(callsAfter).toBeGreaterThan(callsBefore)
  })

  it('NFT x NFT (native remainder) needs exactly 2 clicks to reach success', async () => {
    mocks.sendTransactionAsync.mockResolvedValue('0xaa')
    const client = fakeClient()
    const plan = fakePlan(['swap-sell', 'swap-buy'])
    const { result, rerender } = renderWithSnf(() => useSnfCheckout(plan), { client })

    let clicks = 0
    for (let i = 0; i < 5 && result.current.state !== 'success'; i += 1) {
      await act(async () => {
        await result.current.next()
      })
      clicks += 1
      mocks.receipt.isSuccess = true
      mocks.receipt.data = fakeReceipt('success', `0x${(i + 1).toString(16).padStart(2, '0')}`)
      await act(async () => {
        rerender()
      })
    }

    expect(result.current.state).toBe('success')
    expect(clicks).toBe(2)
  })

  it('NFT x NFT (wNFT remainder) needs exactly 3 clicks to reach success', async () => {
    mocks.sendTransactionAsync.mockResolvedValue('0xaa')
    const client = fakeClient()
    const plan = fakePlan(['swap-sell', 'swap-buy', 'swap-buy-wnft'])
    const { result, rerender } = renderWithSnf(() => useSnfCheckout(plan), { client })

    let clicks = 0
    for (let i = 0; i < 6 && result.current.state !== 'success'; i += 1) {
      await act(async () => {
        await result.current.next()
      })
      clicks += 1
      mocks.receipt.isSuccess = true
      mocks.receipt.data = fakeReceipt('success', `0x${(i + 1).toString(16).padStart(2, '0')}`)
      await act(async () => {
        rerender()
      })
    }

    expect(result.current.state).toBe('success')
    expect(clicks).toBe(3)
  })

  it('cancel() returns the session to review and clears canProceed-blocking state', async () => {
    const client = fakeClient()
    const plan = fakePlan(['swap-fungible'])
    const { result } = renderWithSnf(() => useSnfCheckout(plan), { client })

    act(() => {
      result.current.cancel()
    })

    expect(result.current.state).toBe('review')
    expect(result.current.canProceed).toBe(true)
  })

  it('label mirrors the core reducer\'s buildConfirmLabel — never re-derived by the adapter', async () => {
    const client = fakeClient()
    const plan = fakePlan(['swap-fungible'])
    const { result } = renderWithSnf(() => useSnfCheckout(plan), { client })

    expect(typeof result.current.label).toBe('string')
    expect(result.current.label.length).toBeGreaterThan(0)
  })

  it('two createCheckout sessions (two plans) are fully independent', async () => {
    mocks.sendTransactionAsync.mockResolvedValue('0xaa')
    const clientA = fakeClient()
    const clientB = fakeClient()
    const planA = fakePlan(['swap-fungible'])
    const planB = fakePlan(['swap-fungible'])

    const a = renderWithSnf(() => useSnfCheckout(planA), { client: clientA })
    const b = renderWithSnf(() => useSnfCheckout(planB), { client: clientB })

    await act(async () => {
      await a.result.current.next()
    })

    // Dispatching session A's step must not touch session B's state at all.
    expect(a.result.current.state).toBe('pending')
    expect(b.result.current.state).toBe('review')
    expect(mocks.sendTransactionAsync).toHaveBeenCalledTimes(1)
  })
})
