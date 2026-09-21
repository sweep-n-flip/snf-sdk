import type { PublicClient } from 'viem'
import { vi } from 'vitest'

import { getChain } from '../../src/chains/registry'
import { getAmountIn, getAmountOut } from '../../src/math/quoteMath'
import type { SnfClientContext } from '../../src/types/client.types'

/**
 * Shared fixture builder for `test/quote/{reconciliation,quoteBuy,quoteSell}.test.ts`
 * (plan 12). `quoteBuy`/`quoteSell` call `resolveCollection` (plan 10) and, in
 * count-mode, `poolInventory` (plan 11) BEFORE ever reaching `loadQuoteContext`
 * (this plan) — so a full end-to-end test needs every one of those modules' own
 * `multicall`/transport reads mocked too, not just `loadQuoteContext`'s. This file
 * is NOT itself a `*.test.ts` (vitest's own glob excludes it), so it adds no test
 * count; it exists purely to avoid ~300 lines of copy-pasted mock plumbing across
 * the three real test files (documented as a deviation in `snf-54-12-SUMMARY.md`
 * — the plan's `files_modified` lists three test files but not this one).
 *
 * Every multicall batch below is dispatched by its own exact, source-verified
 * shape (`functionName[]` + length) — see each branch's comment for which real
 * call site it stands in for.
 */

export type ReadResult = { readonly status: 'success' | 'failure'; readonly result?: unknown }

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as `0x${string}`
const DEFAULT_ROYALTY_CAP_E18 = 10n ** 18n // "no cap" sentinel, matches NO_CAP_BPS

export interface RoyaltyLine {
  readonly tokenId: string
  readonly receiver: `0x${string}`
  readonly amount: bigint
}

export interface FixtureConfig {
  readonly chainId?: number
  readonly pair: `0x${string}`
  readonly wrapper: `0x${string}`
  readonly collection: `0x${string}`
  readonly quoteToken?: `0x${string}`
  readonly wrapperIsToken0?: boolean
  readonly reserves: { readonly base: bigint; readonly wnft: bigint }
  readonly wrapperDecimals?: number
  readonly marketplaceFeeE18: bigint
  readonly royaltyCapE18?: bigint
  readonly side: 'buy' | 'sell'
  /** `wnftUnitsFromCount(tokenIds.length)` — the plain leg's `amountOut`/`amountIn`. */
  readonly units: bigint
  /** The plain (non-`Collection`) Router read on the wrapper leg. */
  readonly poolLeg: bigint
  /** The `*Collection` Router's own gross (buy) / net (sell) answer. */
  readonly routerTotal: bigint
  /** Round-2 `royaltyInfo` results, one per `tokenIds[i]`, in order. */
  readonly perId: readonly RoyaltyLine[]
  /** `poolInventory`'s subgraph-fallback candidate list (count-mode buy only). */
  readonly candidateTokenIds?: readonly string[]
  readonly redemptionLocked?: boolean
  /** Forces `poolInventory`'s `ERC721Enumerable` probe to succeed instead of
   * falling to the subgraph — unused by the reconciliation math either way. */
  readonly enumerableSupported?: boolean
}

export interface QuoteEnv {
  readonly ctx: SnfClientContext
  readonly multicall: ReturnType<typeof vi.fn>
  readonly simulateContract: ReturnType<typeof vi.fn>
  calls(): readonly { readonly contracts: readonly { readonly functionName: string; readonly args: readonly unknown[] }[] }[]
}

function fnNames(contracts: readonly { readonly functionName: string }[]): readonly string[] {
  return contracts.map((c) => c.functionName)
}

export function buildQuoteEnv(cfg: FixtureConfig): QuoteEnv {
  const chainId = cfg.chainId ?? 8453
  const chain = getChain(chainId)
  const quoteToken = cfg.quoteToken ?? chain.quoteToken
  const wrapperIsToken0 = cfg.wrapperIsToken0 ?? false
  const [token0, token1] = wrapperIsToken0 ? [cfg.wrapper, quoteToken] : [quoteToken, cfg.wrapper]
  const [reserve0, reserve1] = wrapperIsToken0 ? [cfg.reserves.wnft, cfg.reserves.base] : [cfg.reserves.base, cfg.reserves.wnft]
  const wrapperDecimals = cfg.wrapperDecimals ?? 18
  const royaltyCapE18 = cfg.royaltyCapE18 ?? DEFAULT_ROYALTY_CAP_E18
  const candidateTokenIds = cfg.candidateTokenIds ?? cfg.perId.map((p) => p.tokenId)
  const enumerableSupported = cfg.enumerableSupported ?? false

  const collectionAmounts: readonly bigint[] =
    cfg.side === 'buy' ? [cfg.routerTotal, cfg.units] : [cfg.units, cfg.routerTotal]
  const plainAmounts: readonly bigint[] = cfg.side === 'buy' ? [cfg.poolLeg, cfg.units] : [cfg.units, cfg.poolLeg]

  const round2Results: readonly ReadResult[] = cfg.perId.map((line) => ({
    status: 'success',
    result: [line.receiver, line.amount],
  }))

  const calls: { readonly contracts: readonly { readonly functionName: string; readonly args: readonly unknown[] }[] }[] = []

  const multicall = vi.fn(
    async (params: {
      readonly contracts: readonly { readonly functionName: string; readonly args: readonly unknown[] }[]
    }): Promise<readonly ReadResult[]> => {
      calls.push(params)
      const fns = fnNames(params.contracts)
      const len = fns.length

      // poolInventory's ERC721Enumerable supportsInterface probe (1 entry).
      if (len === 1 && fns[0] === 'supportsInterface') {
        return [{ status: 'success', result: enumerableSupported }]
      }
      // The fungible wNFT leg's own single-entry getAmountsIn/getAmountsOut
      // (quoteBuy/quoteSell's `args.amount` branch) — computed live from `cfg.
      // reserves` via the SAME bigint curve the Router itself runs, so the
      // Router-mock's answer and quoteBuy/quoteSell's own local reconstruction
      // always agree unless a test deliberately overrides this branch.
      if (len === 1 && (fns[0] === 'getAmountsIn' || fns[0] === 'getAmountsOut')) {
        const requested = params.contracts[0]?.args[0] as bigint
        const netFee = BigInt(chain.poolNetFee)
        if (fns[0] === 'getAmountsIn') {
          const cost = getAmountIn(requested, cfg.reserves.base, cfg.reserves.wnft, netFee)
          return [{ status: 'success', result: [cost ?? 0n, requested] }]
        }
        const proceeds = getAmountOut(requested, cfg.reserves.wnft, cfg.reserves.base, netFee)
        return [{ status: 'success', result: [requested, proceeds ?? 0n] }]
      }
      // resolveCollection batchA: getWrapper + name + symbol.
      if (fns[0] === 'getWrapper') {
        return [
          { status: 'success', result: cfg.wrapper },
          { status: 'success', result: 'Test Collection' },
          { status: 'success', result: 'TEST' },
        ]
      }
      // resolveCollection batchB: wrapper.collection() + getPair(wrapper, base) per candidate.
      if (fns[0] === 'collection' && len === 2 && fns[1] === 'getPair') {
        return [
          { status: 'success', result: cfg.collection },
          { status: 'success', result: cfg.pair },
        ]
      }
      // poolInventory's WERC721.collection() probe on BOTH pair slots.
      if (fns[0] === 'collection' && len === 2 && fns[1] === 'collection') {
        return wrapperIsToken0
          ? [{ status: 'success', result: cfg.collection }, { status: 'failure' }]
          : [{ status: 'failure' }, { status: 'success', result: cfg.collection }]
      }
      // resolveCollection batchC: getReserves + token0 + token1 (native base only).
      if (fns[0] === 'getReserves' && len === 3) {
        return [
          { status: 'success', result: [reserve0, reserve1, 0] },
          { status: 'success', result: token0 },
          { status: 'success', result: token1 },
        ]
      }
      // poolInventory's pairContracts: token0 + token1 + getReserves.
      if (fns[0] === 'token0' && len === 3) {
        return [
          { status: 'success', result: token0 },
          { status: 'success', result: token1 },
          { status: 'success', result: [reserve0, reserve1, 0] },
        ]
      }
      // quoteContext round1 (8 entries).
      if (fns[0] === 'getReserves' && len >= 6) {
        return [
          { status: 'success', result: [reserve0, reserve1, 0] },
          { status: 'success', result: token0 },
          { status: 'success', result: token1 },
          { status: 'success', result: wrapperDecimals },
          { status: 'success', result: cfg.marketplaceFeeE18 },
          { status: 'success', result: royaltyCapE18 },
          { status: 'success', result: collectionAmounts },
          { status: 'success', result: plainAmounts },
        ]
      }
      // resolveRoyalty's own shape-only probe (default sampleIds=[1n], unused by
      // this plan's reconciliation math — any well-formed response is fine).
      if (fns[0] === 'supportsInterface' && len >= 2) {
        const first = cfg.perId[0]
        return [
          { status: 'success', result: true },
          { status: 'success', result: royaltyCapE18 },
          { status: 'success', result: [first?.receiver ?? ZERO_ADDRESS, first?.amount ?? 0n] },
        ]
      }
      // quoteContext round2: royaltyInfo per tokenId.
      if (fns[0] === 'royaltyInfo') {
        return round2Results
      }
      throw new Error(`buildQuoteEnv: unmocked multicall batch [${fns.join(',')}]`)
    },
  )

  const simulateContract = vi.fn(async () => {
    if (cfg.redemptionLocked) {
      throw new Error('execution reverted: transfer role denied')
    }
    return { result: undefined }
  })

  const publicClient = {
    multicall,
    simulateContract,
    getBlockNumber: vi.fn(async () => 999_999n),
  } as unknown as PublicClient

  const inventoryData =
    candidateTokenIds.length > 0
      ? { id: cfg.wrapper, symbol: 'W', name: 'W', decimals: 18, wrapping: true, tokenIds: candidateTokenIds }
      : null

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
        throw new Error('subgraph down (reserveUSD enrichment is best-effort)')
      }),
      inventory: vi.fn(async () => ({
        data: inventoryData,
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

  return { ctx, multicall, simulateContract, calls: () => calls }
}
