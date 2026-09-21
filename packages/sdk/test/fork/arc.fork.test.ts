import { createPublicClient, defineChain, http } from 'viem'
import type { Chain, PublicClient } from 'viem'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createSnfClient } from '../../src/client'
import { ROUTER_NATIVE_ERC20_ABI } from '../../src/abis/UniswapV2Router01CollectionNativeERC20'
import { deriveBounds } from '../../src/build/bounds'
import { DEFAULT_SLIPPAGE_BPS } from '../../src/build/validate'
import { toNativeValue } from '../../src/chains/units'
import type { SnfClient } from '../../src/types/client.types'

import { FORK_LANES, anvilMissingMessage, resolveAnvilBinary, startAnvil } from './anvil'
import type { AnvilInstance } from './anvil'

/**
 * The Arc fork lane (Task 2, R11, R20; 54-SPEC.md). Arc's `UniswapV2Router01Collection
 * NativeERC20` variant is the whole reason `chains/units.ts` exists: native USDC is
 * the gas token (18-dec `msg.value`), but the pool's quote token is the USDC ERC-20
 * predeploy at SIX decimals — same underlying balance, two views, related by
 * `NATIVE_SCALE = 1e12`. Every assertion here reads `NATIVE_SCALE()`/`WETH()` from the
 * REAL deployed Router, never from the registry, so a registry typo cannot silently
 * pass this lane.
 */

const ARC_LANE = FORK_LANES.find((l) => l.key === 'arc')
if (!ARC_LANE) throw new Error('arc lane missing from chains.fork.json')

const anvilBin = resolveAnvilBinary()
const describeOrSkip = anvilBin ? describe : describe.skip
if (!anvilBin) {
  // eslint-disable-next-line no-console
  console.warn(anvilMissingMessage())
}

describeOrSkip(`Arc fork lane (chainId ${ARC_LANE.chainId}, block ${ARC_LANE.forkBlockNumber})`, () => {
  let anvil: AnvilInstance
  let chain: Chain
  let publicClient: PublicClient
  let snf: SnfClient

  beforeAll(async () => {
    anvil = await startAnvil(ARC_LANE)
    chain = defineChain({
      id: anvil.chainId,
      name: 'arc-fork',
      nativeCurrency: { name: 'USD Coin', symbol: 'USDC', decimals: 18 },
      rpcUrls: { default: { http: [anvil.url] } },
    })
    publicClient = createPublicClient({ chain, transport: http(anvil.url) })
    snf = createSnfClient({ chainId: 5042, publicClient })
  }, 60_000)

  afterAll(async () => {
    await anvil?.stop()
  })

  it('NATIVE_SCALE() reads 1_000_000_000_000n from the real deployed Router — not the registry', async () => {
    const scale = await publicClient.readContract({
      address: ARC_LANE!.fixtures['router02'] as `0x${string}`,
      abi: ROUTER_NATIVE_ERC20_ABI,
      functionName: 'NATIVE_SCALE',
    })
    expect(scale).toBe(1_000_000_000_000n)
  })

  it("WETH() equals the USDC predeploy — Arc's Router has no WETH9-style wrapper", async () => {
    const weth = await publicClient.readContract({
      address: ARC_LANE!.fixtures['router02'] as `0x${string}`,
      abi: ROUTER_NATIVE_ERC20_ABI,
      functionName: 'WETH',
    })
    expect((weth as string).toLowerCase()).toBe((ARC_LANE!.fixtures['baseToken'] as string).toLowerCase())
  })

  describe('reconciliation, both directions (R8, R11, R20)', () => {
    it('quoteBuy(1 id) matches getAmountsInCollection — pool-side amounts stay 6-decimal (quote-unit) magnitude, never 18', async () => {
      const fixtures = ARC_LANE!.fixtures as { collection: `0x${string}` }
      const quote = await snf.quoteBuy({ chainId: 5042, collection: fixtures.collection, tokenIds: ['1'] })
      expect(quote.reconciled).toBe(true)
      // 6-decimal magnitude sanity: a whole ARCT NFT costs a few thousand quote units
      // (observed 4261 this session), nowhere near 18-decimal wei magnitude (1e15+).
      expect(quote.totalCost!.value).toBeGreaterThan(0n)
      expect(quote.totalCost!.value).toBeLessThan(1_000_000_000n) // < 1e9 quote units
    })

    it('quoteSell(1 id) matches getAmountsOutCollection and reconciles', async () => {
      const fixtures = ARC_LANE!.fixtures as { collection: `0x${string}` }
      const quote = await snf.quoteSell({ chainId: 5042, collection: fixtures.collection, tokenIds: ['2'] })
      expect(quote.reconciled).toBe(true)
      expect(quote.totalProceeds!.value).toBeGreaterThan(0n)
    })
  })

  describe('the two unit axes on the real Router variant (R11)', () => {
    // FINDING (environment limitation, NOT an SDK bug — packages/sdk/src is out of
    // scope for this plan regardless): a real SEND of swapETHForExactTokensCollection
    // reverts on THIS anvil fork of Arc with `TransferHelper::safeTransfer: transfer
    // failed`. Traced with `cast call --trace` against a locally started anvil fork
    // (same RPC/block as this lane): the USDC predeploy (0x3600...0000) is itself a
    // proxy that `delegatecall`s an implementation whose `transfer()` in turn calls a
    // chain-specific precompile at 0x1800...0000 — which anvil, a generic EVM
    // simulator, does not implement (`OpcodeNotFound`). Every READ in this file
    // (NATIVE_SCALE, WETH, quoteBuy/quoteSell reconciliation, both fully exercised
    // above against the real deployed Router bytecode) works perfectly on the fork;
    // only a native-value-moving WRITE fails, because Arc's "native USDC = the ERC-20
    // predeploy balance" mechanic depends on real-client precompile support no
    // generic fork tool currently replicates. `buildBuy` itself cannot even be
    // constructed here (build/gas.ts's unconditional, by-design gas-estimation
    // re-throw on a genuine simulated revert — the same chicken-and-egg class as the
    // ERC-20-approval finding in base.fork.test.ts), so the two assertions below
    // verify the SAME formula `buildBuy`/`chains/units.ts` uses internally
    // (`deriveBounds` + `toNativeValue`, both pure, no send required) against a REAL,
    // Router-reconciled quote, cross-checked against the on-chain `NATIVE_SCALE()`
    // this describe block's first `it` already read from the real deployed bytecode.
    it('deriveBounds + toNativeValue (the exact functions buildBuy uses internally) produce tx.value === amountInMax * the on-chain NATIVE_SCALE, fed by a real reconciled quote', async () => {
      const fixtures = ARC_LANE!.fixtures as { collection: `0x${string}` }
      const quote = await snf.quoteBuy({ chainId: 5042, collection: fixtures.collection, tokenIds: ['3'] })
      expect(quote.reconciled).toBe(true)

      const onChainScale = await publicClient.readContract({
        address: ARC_LANE!.fixtures['router02'] as `0x${string}`,
        abi: ROUTER_NATIVE_ERC20_ABI,
        functionName: 'NATIVE_SCALE',
      })

      const bounds = deriveBounds({
        side: 'buy',
        total: quote.totalCost!.value,
        slippageBps: DEFAULT_SLIPPAGE_BPS,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 1200),
      })
      const amountInMax = bounds.amountInMax!
      expect(amountInMax).toBeGreaterThan(0n)
      expect(amountInMax).toBeLessThan(1_000_000_000n) // 6-decimal magnitude, not 18

      const txValue = toNativeValue(5042, amountInMax)
      expect(txValue).toBe(amountInMax * (onChainScale as bigint))
      expect(txValue).toBe(amountInMax * 1_000_000_000_000n)
    })
  })
})
