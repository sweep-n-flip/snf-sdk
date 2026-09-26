import type { PublicClient } from 'viem'
import { vi } from 'vitest'

import { getChain } from '../../src/chains/registry'
import type { SnfClientContext } from '../../src/types/client.types'

/**
 * `buildLiquidityEnv(cfg)` — the shared mocked `publicClient` every liquidity test in
 * this plan (and, per the plan's own `output` note, every liquidity test in plans
 * 04-06) uses. NOT itself a `*.test.ts` file (vitest's glob excludes it), so it adds
 * no test count.
 *
 * Unlike `test/quote/testHelpers.ts`'s `buildQuoteEnv` (which dispatches by matching
 * a whole multicall batch's exact `functionName[]` shape/length), this helper
 * dispatches EACH call in a batch INDIVIDUALLY, keyed by
 * `address.toLowerCase() + functionName` (+ args where the call site needs to
 * distinguish, e.g. `balanceOf(pair)` vs `balanceOf(owner)`). That is what lets the
 * SAME config serve `poolState.ts`'s multi-round loaders, `missingApprovals`'s
 * single-round batch, `runPreflight`'s single-round batch and a `Router.quote`
 * cross-check round alike — none of those call sites are coupled to any other's
 * batch shape.
 */

export type ReadResult = { readonly status: 'success' | 'failure'; readonly result?: unknown }

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as `0x${string}`

export interface LiquidityBaseTokenConfig {
  readonly address: `0x${string}`
  readonly decimals: number
  readonly symbol: string
}

export interface RecordedCall {
  readonly address: string
  readonly functionName: string
  readonly args: readonly unknown[]
  readonly blockNumber: bigint | undefined
}

export interface LiquidityEnvConfig {
  readonly chainId?: 8453 | 5042
  readonly collection: `0x${string}`
  /** `null`/omitted — no wrapper deployed yet (`Factory.getWrapper` returns zero). */
  readonly wrapper?: `0x${string}` | null
  /** `null`/omitted — no pair yet. Only meaningful when `wrapper` is also set. */
  readonly pair?: `0x${string}` | null
  readonly wrapperIsToken0?: boolean
  readonly reserves?: { readonly base: bigint; readonly wnft: bigint }
  /** Defaults to `reserves` — set explicitly to exercise a balance/reserve mismatch
   * (`Pair.mint`/`Pair.burn` read balances, never the reserve cache). */
  readonly balances?: { readonly base: bigint; readonly wnft: bigint }
  readonly totalSupply?: bigint
  readonly feeTo?: `0x${string}`
  /** `null`/omitted — the native pool. An explicit config targets an ERC-20 base. */
  readonly baseToken?: LiquidityBaseTokenConfig | null
  /** Forces the ERC-20 base's `decimals()` read to fail (a non-ERC-20/malformed
   * address). */
  readonly baseDecimalsUnreadable?: boolean
  /** `Factory.getCollection(base)` — non-zero makes the loader's `baseIsWrapper`
   * true. */
  readonly baseIsWrapperOfCollection?: `0x${string}`
  readonly owner?: `0x${string}`
  readonly ownerLp?: bigint
  readonly erc721ApprovedForAll?: boolean
  readonly erc20Allowance?: bigint
  readonly lpAllowance?: bigint
  /** tokenId (decimal string) -> current owner, for a pre-flight `ownerOf` check. */
  readonly ownerOf?: Readonly<Record<string, `0x${string}`>>
  readonly nativeBalance?: bigint
  /** Overrides `Router.quote`'s own on-chain answer — default: the real
   * `floor(amountA * reserveB / reserveA)` the Router itself computes, so a test that
   * never overrides this still reconciles against a mathematically honest mock. */
  readonly routerQuoteOverride?: bigint
  /** `Factory.getPair(wrapper, base)`'s answer, when it must DIFFER from the
   * configured `pair` — the spoofed/stale-pair adversarial case `loadPairState` must
   * reject. Defaults to `pair` itself (the honest case). */
  readonly factoryGetPairOverride?: `0x${string}`
  /** Forces the wrapper's `collection()` probe to fail — simulates neither pair slot
   * answering `collection()` (`loadPairState`'s "not an SnF pool" case). */
  readonly wrapperCollectionUnreadable?: boolean
  /** Forces the BASE token's `collection()` probe to also succeed — simulates a
   * spoofed base token answering `collection()` too (`loadPairState`'s "both slots
   * answer" case). */
  readonly baseAnswersCollection?: boolean
}

export interface LiquidityEnv {
  readonly ctx: SnfClientContext
  readonly multicall: ReturnType<typeof vi.fn>
  readonly simulateContract: ReturnType<typeof vi.fn>
  readonly estimateContractGas: ReturnType<typeof vi.fn>
  readonly getBalance: ReturnType<typeof vi.fn>
  readonly getBlockNumber: ReturnType<typeof vi.fn>
  calls(): readonly RecordedCall[]
}

function isAddr(addr: string, target: string | null | undefined): boolean {
  return target !== null && target !== undefined && addr.toLowerCase() === target.toLowerCase()
}

function argsOf(args: readonly unknown[] | undefined): readonly unknown[] {
  return args ?? []
}

export function buildLiquidityEnv(cfg: LiquidityEnvConfig): LiquidityEnv {
  const chainId = cfg.chainId ?? 8453
  const chain = getChain(chainId)
  const reserves = cfg.reserves ?? { base: 0n, wnft: 0n }
  const balances = cfg.balances ?? reserves
  const totalSupply = cfg.totalSupply ?? 0n
  const feeTo = cfg.feeTo ?? ZERO_ADDRESS
  const wrapperIsToken0 = cfg.wrapperIsToken0 ?? true
  const wrapper = cfg.wrapper ?? null
  const pair = cfg.pair ?? null
  const baseToken = cfg.baseToken ?? null
  const baseAddress = baseToken?.address ?? chain.quoteToken
  const ownerOf = cfg.ownerOf ?? {}

  const token0 = wrapper === null ? undefined : wrapperIsToken0 ? wrapper : baseAddress
  const token1 = wrapper === null ? undefined : wrapperIsToken0 ? baseAddress : wrapper

  const calls: RecordedCall[] = []

  function resolveOne(call: { readonly address: string; readonly functionName: string; readonly args?: readonly unknown[] }): ReadResult {
    const { address, functionName } = call
    const args = argsOf(call.args)
    let matchedRole = false

    // ── Factory ────────────────────────────────────────────────────────────────
    if (isAddr(address, chain.factory)) {
      matchedRole = true
      switch (functionName) {
        case 'getWrapper':
          return { status: 'success', result: wrapper ?? ZERO_ADDRESS }
        case 'feeTo':
          return { status: 'success', result: feeTo }
        case 'getCollection':
          return { status: 'success', result: cfg.baseIsWrapperOfCollection ?? ZERO_ADDRESS }
        case 'getPair':
          return { status: 'success', result: cfg.factoryGetPairOverride ?? pair ?? ZERO_ADDRESS }
      }
    }

    // ── Wrapper (WERC721) ──────────────────────────────────────────────────────
    if (isAddr(address, wrapper)) {
      matchedRole = true
      switch (functionName) {
        case 'collection':
          if (cfg.wrapperCollectionUnreadable) return { status: 'failure' }
          return { status: 'success', result: cfg.collection }
        case 'balanceOf':
          return { status: 'success', result: balances.wnft }
      }
    }

    // ── Pair (UniswapV2Pair) ───────────────────────────────────────────────────
    if (isAddr(address, pair)) {
      matchedRole = true
      switch (functionName) {
        case 'token0':
          return { status: 'success', result: token0 }
        case 'token1':
          return { status: 'success', result: token1 }
        case 'getReserves': {
          const [reserve0, reserve1] = wrapperIsToken0 ? [reserves.wnft, reserves.base] : [reserves.base, reserves.wnft]
          return { status: 'success', result: [reserve0, reserve1, 0] }
        }
        case 'totalSupply':
          return { status: 'success', result: totalSupply }
        case 'balanceOf':
          return { status: 'success', result: cfg.ownerLp ?? 0n }
        case 'allowance':
          return { status: 'success', result: cfg.lpAllowance ?? 0n }
      }
    }

    // ── Base token (ERC-20 or the chain's native WETH9-style quote token) ─────
    if (isAddr(address, baseAddress)) {
      matchedRole = true
      switch (functionName) {
        case 'decimals':
          if (cfg.baseDecimalsUnreadable) return { status: 'failure' }
          return { status: 'success', result: baseToken?.decimals ?? chain.quoteDecimals }
        case 'symbol':
          return { status: 'success', result: baseToken?.symbol ?? chain.nativeSymbol }
        case 'balanceOf':
          return { status: 'success', result: balances.base }
        case 'allowance':
          return { status: 'success', result: cfg.erc20Allowance ?? 0n }
        case 'collection':
          // Only the honest WERC721 answers `collection()` — UNLESS a test asks this
          // helper to simulate a spoofed base token that also answers it.
          if (cfg.baseAnswersCollection) return { status: 'success', result: cfg.collection }
          return { status: 'failure' }
      }
    }

    // ── The raw ERC-721 collection (NFT approvals/ownership, never the wrapper) ─
    if (isAddr(address, cfg.collection)) {
      matchedRole = true
      switch (functionName) {
        case 'isApprovedForAll':
          return { status: 'success', result: cfg.erc721ApprovedForAll ?? false }
        case 'ownerOf': {
          const tokenId = String(args[0])
          const owner = ownerOf[tokenId]
          return owner ? { status: 'success', result: owner } : { status: 'failure' }
        }
      }
    }

    // ── Router (AMM math helper, cross-check round) ───────────────────────────
    if (isAddr(address, chain.router02)) {
      matchedRole = true
      if (functionName === 'quote') {
        if (cfg.routerQuoteOverride !== undefined) return { status: 'success', result: cfg.routerQuoteOverride }
        const [amountA, reserveA, reserveB] = args as readonly [bigint, bigint, bigint]
        if (amountA <= 0n || reserveA <= 0n || reserveB <= 0n) return { status: 'failure' }
        return { status: 'success', result: (amountA * reserveB) / reserveA }
      }
    }

    if (matchedRole) return { status: 'failure' }
    throw new Error(`buildLiquidityEnv: unmocked call ${functionName} on ${address} (no configured role owns this address)`)
  }

  const multicall = vi.fn(
    async (params: {
      readonly contracts: readonly { readonly address: string; readonly functionName: string; readonly args?: readonly unknown[] }[]
      readonly blockNumber?: bigint
    }): Promise<readonly ReadResult[]> => {
      const results: ReadResult[] = []
      for (const call of params.contracts) {
        calls.push({ address: call.address, functionName: call.functionName, args: argsOf(call.args), blockNumber: params.blockNumber })
        results.push(resolveOne(call))
      }
      return results
    },
  )

  const simulateContract = vi.fn(async () => ({ result: undefined }))
  const estimateContractGas = vi.fn(async () => 1_000_000n)
  const getBalance = vi.fn(async () => cfg.nativeBalance ?? 0n)
  const getBlockNumber = vi.fn(async () => 999_999n)
  const readContract = vi.fn(async () => undefined)

  const publicClient = {
    multicall,
    simulateContract,
    estimateContractGas,
    getBalance,
    getBlockNumber,
    readContract,
  } as unknown as PublicClient

  const ctx = {
    config: { chainId, publicClient },
    chain,
    publicClient,
    providers: {},
    transport: {
      pools: vi.fn(async () => {
        throw new Error('subgraph down (enrichment is best-effort)')
      }),
      pairById: vi.fn(async () => {
        throw new Error('subgraph down (enrichment is best-effort)')
      }),
      inventory: vi.fn(async () => ({
        data: null,
        asOfBlock: 999_999n,
        lagSeconds: 0,
        stale: false,
        revalidating: false,
      })),
      meta: vi.fn(),
      clear: vi.fn(),
    },
    nextTxInvalidationVersion: () => 1,
  } as unknown as SnfClientContext

  return { ctx, multicall, simulateContract, estimateContractGas, getBalance, getBlockNumber, calls: () => calls }
}
