import type { PublicClient } from 'viem'
import { vi } from 'vitest'

import { getChain } from '../../src/chains/registry'
import { getAmountsInChain, getAmountsOutChain } from '../../src/math/quoteMath'
import type { SnfClientContext } from '../../src/types/client.types'

/**
 * Fixture builder for `test/quote/quoteSwap.test.ts`. Every multicall entry is
 * resolved ONE AT A TIME by its `functionName`/`address`/`args` (mirrors
 * `nftToNftTestHelpers.ts`'s per-entry dispatch, not `testHelpers.ts`'s
 * whole-batch-shape dispatch) — `quoteSwap` issues several small multicalls with
 * overlapping shapes (`getPair` for path resolution, `getReserves`/`token0`/
 * `delegates` per hop, `decimals`/`symbol` per token, the Router's own
 * `getAmountsOut`/`getAmountsIn`), which a shape-only dispatcher cannot
 * disambiguate.
 *
 * Each `HopFixture`'s `pair` token0 is ALWAYS `from` (never `to`) — an intentional
 * mock simplification `loadHops` itself is indifferent to (it derives reserveIn/
 * reserveOut by comparing the path address against whichever `token0()` this mock
 * reports, not by any real on-chain token ordering convention).
 */

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as `0x${string}`

export interface HopFixture {
  readonly from: `0x${string}`
  readonly to: `0x${string}`
  readonly pair: `0x${string}`
  readonly reserveFrom: bigint
  readonly reserveTo: bigint
  readonly delegated?: boolean
}

export interface SwapEnvConfig {
  readonly chainId?: number
  /** The hops of whichever path `resolvePath` SHOULD resolve — in trade order. */
  readonly hops: readonly HopFixture[]
  readonly tokenMeta?: Readonly<Record<string, { readonly decimals: number; readonly symbol: string }>>
  /** Override the Router's own on-chain answer away from the live-computed one, to
   * exercise the `QUOTE_RECONCILIATION_FAILED` path. */
  readonly routerAmountsOverride?: readonly bigint[]
  /** Simulates a chain whose registry entry carries a DIFFERENT `delegateNetFee` —
   * applied to BOTH the returned `ctx.chain.delegateNetFee` AND the Router mock's own
   * live-computed cross-check answer, so the two-different-chains parity test isn't
   * fighting a stale mock built against the real registry's value. */
  readonly delegateNetFeeOverride?: number
}

export interface SwapEnv {
  readonly ctx: SnfClientContext
  readonly multicall: ReturnType<typeof vi.fn>
}

function eqAddr(a: string, b: `0x${string}`): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

function findHop(hops: readonly HopFixture[], from: string, to: string): HopFixture | undefined {
  return hops.find((h) => eqAddr(h.from, from as `0x${string}`) && eqAddr(h.to, to as `0x${string}`))
}

export function buildSwapEnv(cfg: SwapEnvConfig): SwapEnv {
  const chainId = cfg.chainId ?? 8453
  const registryChain = getChain(chainId)
  const delegateNetFee = cfg.delegateNetFeeOverride ?? registryChain.delegateNetFee
  const chain = { ...registryChain, delegateNetFee }
  const netFees = cfg.hops.map((h) => BigInt(h.delegated ? delegateNetFee : chain.poolNetFee))
  const reserves = cfg.hops.map((h) => [h.reserveFrom, h.reserveTo] as const)

  function resolveEntry(entry: { readonly address: `0x${string}`; readonly functionName: string; readonly args: readonly unknown[] }) {
    const { address, functionName, args } = entry

    if (functionName === 'getPair') {
      const [a, b] = args as [string, string]
      const hop = findHop(cfg.hops, a, b)
      return { status: 'success' as const, result: hop?.pair ?? ZERO_ADDRESS }
    }
    if (functionName === 'getReserves') {
      const hop = cfg.hops.find((h) => eqAddr(h.pair, address))
      if (!hop) return { status: 'failure' as const }
      return { status: 'success' as const, result: [hop.reserveFrom, hop.reserveTo, 0] }
    }
    if (functionName === 'token0') {
      const hop = cfg.hops.find((h) => eqAddr(h.pair, address))
      if (!hop) return { status: 'failure' as const }
      return { status: 'success' as const, result: hop.from }
    }
    if (functionName === 'delegates') {
      const [a, b] = args as [string, string]
      const hop = findHop(cfg.hops, a, b)
      return { status: 'success' as const, result: hop?.delegated ?? false }
    }
    if (functionName === 'decimals' || functionName === 'symbol') {
      const meta = cfg.tokenMeta?.[address.toLowerCase()]
      if (!meta) return { status: 'failure' as const }
      return { status: 'success' as const, result: functionName === 'decimals' ? meta.decimals : meta.symbol }
    }
    if (functionName === 'getAmountsOut' || functionName === 'getAmountsIn') {
      const amount = args[0] as bigint
      const local =
        functionName === 'getAmountsOut'
          ? getAmountsOutChain(amount, reserves, netFees)
          : getAmountsInChain(amount, reserves, netFees)
      const result = cfg.routerAmountsOverride ?? local ?? []
      return { status: 'success' as const, result }
    }
    throw new Error(`buildSwapEnv: unmocked multicall entry [${functionName}] on ${address}`)
  }

  const multicall = vi.fn(
    async (params: {
      readonly contracts: readonly { readonly address: `0x${string}`; readonly functionName: string; readonly args: readonly unknown[] }[]
    }) => params.contracts.map((entry) => resolveEntry(entry)),
  )

  const publicClient = { multicall, getBlockNumber: vi.fn(async () => 999_999n) } as unknown as PublicClient

  const ctx = {
    config: { chainId, publicClient },
    chain,
    publicClient,
    providers: {},
    transport: {
      pools: vi.fn(),
      pairById: vi.fn(),
      inventory: vi.fn(),
      meta: vi.fn(),
      clear: vi.fn(),
    },
    nextTxInvalidationVersion: () => 1,
  } as unknown as SnfClientContext

  return { ctx, multicall }
}
