import { createPublicClient, defineChain, http } from 'viem'
import type { Chain, PublicClient } from 'viem'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createSnfClient } from '../../src/client'
import { FACTORY_ABI } from '../../src/abis/UniswapV2Factory'
import { PAIR_ABI } from '../../src/abis/UniswapV2Pair'
import { ROUTER02_COLLECTION_ABI } from '../../src/abis/UniswapV2Router02Collection'
import { getAmountIn, getAmountOut, ONE_E18, SNF_NFT_NET_FEE } from '../../src/math/quoteMath'
import type { SnfClient } from '../../src/types/client.types'

import { FORK_LANES, anvilMissingMessage, resolveAnvilBinary, startAnvil } from './anvil'
import type { AnvilInstance } from './anvil'

/**
 * The Arbitrum fork lane (Task 2, R20; 54-SPEC.md). SushiSwap (Arbitrum mainnet) is
 * this chain's delegate DEX (registry `delegateNetFee: 9970`) — this lane's job is
 * reconciliation on this chain's own (small, real) native NFT pool, PLUS an
 * empirical check for a delegated pair to confirm the registry's `delegateNetFee`
 * against the live Router.
 */

const ARBITRUM_LANE = FORK_LANES.find((l) => l.key === 'arbitrum')
if (!ARBITRUM_LANE) throw new Error('arbitrum lane missing from chains.fork.json')

const anvilBin = resolveAnvilBinary()
const describeOrSkip = anvilBin ? describe : describe.skip
if (!anvilBin) {
  // eslint-disable-next-line no-console
  console.warn(anvilMissingMessage())
}

describeOrSkip(`Arbitrum fork lane (chainId ${ARBITRUM_LANE.chainId}, block ${ARBITRUM_LANE.forkBlockNumber})`, () => {
  let anvil: AnvilInstance
  let chain: Chain
  let publicClient: PublicClient
  let snf: SnfClient

  beforeAll(async () => {
    anvil = await startAnvil(ARBITRUM_LANE)
    chain = defineChain({
      id: anvil.chainId,
      name: 'arbitrum-fork',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [anvil.url] } },
    })
    publicClient = createPublicClient({ chain, transport: http(anvil.url) })
    snf = createSnfClient({ chainId: 42161, publicClient })
  }, 60_000)

  afterAll(async () => {
    await anvil?.stop()
  })

  describe('reconciliation, both directions, against the real deployed Router (R8, R20)', () => {
    it('quoteBuy(1 id) on the WCBERA/WETH pool matches getAmountsInCollection AND an independent local reconstruction', async () => {
      const fixtures = ARBITRUM_LANE!.fixtures as {
        collection: `0x${string}`
        wrapper: `0x${string}`
        pair: `0x${string}`
        baseToken: `0x${string}`
      }
      // Discover a real held tokenId directly from the pool's own reserve — this
      // small pool (8 NFTs at capture time) is enumerable via ERC-721 balanceOf/
      // ownerOf on the wrapper, but the simplest robust source is the Router's own
      // getReserves + a live subgraph-free probe is out of scope here; instead this
      // reads ONE candidate id range and lets quoteBuy's own on-chain check confirm
      // availability (quoteBuy throws TOKENIDS_UNAVAILABLE/NO_ROUTE if the guess is
      // wrong, which would fail this test loudly rather than silently).
      const [reserve0, reserve1] = (await publicClient.readContract({
        address: fixtures.pair,
        abi: PAIR_ABI,
        functionName: 'getReserves',
      })) as readonly [bigint, bigint, number]
      expect(reserve0 > 0n || reserve1 > 0n).toBe(true)

      const quote = await snf.quoteBuy({ chainId: 42161, collection: fixtures.collection, count: 1 })
      expect(quote.reconciled).toBe(true)
      expect(quote.tokenIds?.length).toBe(1)

      const tokenId = quote.tokenIds![0]!
      const routerAnswer = await publicClient.readContract({
        address: ARBITRUM_LANE!.fixtures['router02'] as `0x${string}`,
        abi: ROUTER02_COLLECTION_ABI,
        functionName: 'getAmountsInCollection',
        args: [[BigInt(tokenId)], [fixtures.baseToken, fixtures.collection], false],
      })
      expect(quote.totalCost?.value).toBe((routerAnswer as readonly bigint[])[0])

      const token0 = (await publicClient.readContract({
        address: fixtures.pair,
        abi: PAIR_ABI,
        functionName: 'token0',
      })) as `0x${string}`
      const wrapperIsToken0 = token0.toLowerCase() === fixtures.wrapper.toLowerCase()
      const [reserveBase, reserveWnft] = wrapperIsToken0 ? [reserve1, reserve0] : [reserve0, reserve1]
      const localPoolLeg = getAmountIn(1n * ONE_E18, reserveBase, reserveWnft, SNF_NFT_NET_FEE)
      expect(localPoolLeg).toBeDefined()
      const reconstructed = localPoolLeg! + quote.fees.marketplace.value + quote.fees.royalty.value
      expect(reconstructed).toBe(quote.totalCost?.value)
    })

    it('quoteSell(1 id) matches getAmountsOutCollection AND an independent local reconstruction', async () => {
      const fixtures = ARBITRUM_LANE!.fixtures as {
        collection: `0x${string}`
        wrapper: `0x${string}`
        pair: `0x${string}`
        baseToken: `0x${string}`
      }
      const buyQuote = await snf.quoteBuy({ chainId: 42161, collection: fixtures.collection, count: 1 })
      const tokenId = buyQuote.tokenIds![0]!

      const quote = await snf.quoteSell({ chainId: 42161, collection: fixtures.collection, tokenIds: [tokenId] })
      expect(quote.reconciled).toBe(true)

      const routerAnswer = await publicClient.readContract({
        address: ARBITRUM_LANE!.fixtures['router02'] as `0x${string}`,
        abi: ROUTER02_COLLECTION_ABI,
        functionName: 'getAmountsOutCollection',
        args: [[BigInt(tokenId)], [fixtures.collection, fixtures.baseToken], false],
      })
      expect(quote.totalProceeds?.value).toBe((routerAnswer as readonly bigint[])[1])

      const [reserve0, reserve1] = (await publicClient.readContract({
        address: fixtures.pair,
        abi: PAIR_ABI,
        functionName: 'getReserves',
      })) as readonly [bigint, bigint, number]
      const token0 = (await publicClient.readContract({
        address: fixtures.pair,
        abi: PAIR_ABI,
        functionName: 'token0',
      })) as `0x${string}`
      const wrapperIsToken0 = token0.toLowerCase() === fixtures.wrapper.toLowerCase()
      const [reserveBase, reserveWnft] = wrapperIsToken0 ? [reserve1, reserve0] : [reserve0, reserve1]
      const localPoolLeg = getAmountOut(1n * ONE_E18, reserveWnft, reserveBase, SNF_NFT_NET_FEE)
      expect(localPoolLeg).toBeDefined()
      const reconstructed = localPoolLeg! - quote.fees.marketplace.value - quote.fees.royalty.value
      expect(reconstructed).toBe(quote.totalProceeds?.value)
    })
  })

  describe('delegate fee confirmation (Task 2 point 5, A2)', () => {
    it('reports whether a delegated pair exists on this chain — the registry delegateNetFee (9970) is confirmed live ONLY if one does', async () => {
      const fixtures = ARBITRUM_LANE!.fixtures as { wrapper: `0x${string}`; baseToken: `0x${string}` }
      const factory = '0x85039B2e95558aDdCCf4379728b8433C447E37bE' as `0x${string}`
      const isDelegated = await publicClient.readContract({
        address: factory,
        abi: FACTORY_ABI,
        functionName: 'delegates',
        args: [fixtures.wrapper, fixtures.baseToken],
      })
      // FINDING (Task 2 point 5, A2 — see snf-54-18-SUMMARY.md, Findings, for the
      // full account): probed every registered wrapper on this chain (via the
      // snf-arbitrum subgraph's `currencies(where:{wrapping:true})`, 4 entries) plus
      // several well-known fungible pairs (WETH/ARB, WETH/USDC.e, WETH/USDT) against
      // `Factory.delegates(...)` this session — every single probe returned `false`.
      // No delegated pair currently exists on Arbitrum through the SnF Factory, so
      // the registry's `delegateNetFee: 9970` for this chain remains UNVERIFIED
      // against live bytecode (the value is sourced from
      // `snf-contracts/scripts/delegate-configs.ts`'s committed SushiSwap config,
      // which IS a legitimate source — just not a live on-chain read). This is
      // reported, not silently passed: the assertion below documents the actual
      // observed state rather than assuming a delegate exists.
      expect(isDelegated).toBe(false)
    })
  })
})
