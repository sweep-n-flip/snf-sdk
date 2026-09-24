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
 * The Robinhood Chain fork lane (Task 2). Uniswap V2 (Robinhood
 * Chain mainnet) is this chain's delegate DEX (registry `delegateNetFee: 9970`) —
 * same job as the Arbitrum lane: reconciliation on this chain's own real native NFT
 * pool (ORBIO/WETH), plus an empirical delegated-pair check.
 */

const ROBINHOOD_LANE = FORK_LANES.find((l) => l.key === 'robinhood')
if (!ROBINHOOD_LANE) throw new Error('robinhood lane missing from chains.fork.json')

const anvilBin = resolveAnvilBinary()
const describeOrSkip = anvilBin ? describe : describe.skip
if (!anvilBin) {
  // eslint-disable-next-line no-console
  console.warn(anvilMissingMessage())
}

describeOrSkip(`Robinhood fork lane (chainId ${ROBINHOOD_LANE.chainId}, block ${ROBINHOOD_LANE.forkBlockNumber})`, () => {
  let anvil: AnvilInstance
  let chain: Chain
  let publicClient: PublicClient
  let snf: SnfClient

  beforeAll(async () => {
    anvil = await startAnvil(ROBINHOOD_LANE)
    chain = defineChain({
      id: anvil.chainId,
      name: 'robinhood-fork',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [anvil.url] } },
    })
    publicClient = createPublicClient({ chain, transport: http(anvil.url) })
    snf = createSnfClient({ chainId: 4663, publicClient })
  }, 60_000)

  afterAll(async () => {
    await anvil?.stop()
  })

  describe('reconciliation, both directions, against the real deployed Router', () => {
    it('quoteBuy(1 id) on the ORBIO/WETH pool matches getAmountsInCollection AND an independent local reconstruction', async () => {
      const fixtures = ROBINHOOD_LANE!.fixtures as {
        collection: `0x${string}`
        wrapper: `0x${string}`
        pair: `0x${string}`
        baseToken: `0x${string}`
      }
      const [reserve0, reserve1] = (await publicClient.readContract({
        address: fixtures.pair,
        abi: PAIR_ABI,
        functionName: 'getReserves',
      })) as readonly [bigint, bigint, number]
      expect(reserve0 > 0n || reserve1 > 0n).toBe(true)

      const quote = await snf.quoteBuy({ chainId: 4663, collection: fixtures.collection, count: 1 })
      expect(quote.reconciled).toBe(true)
      const tokenId = quote.tokenIds![0]!

      const routerAnswer = await publicClient.readContract({
        address: ROBINHOOD_LANE!.fixtures['router02'] as `0x${string}`,
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
      const fixtures = ROBINHOOD_LANE!.fixtures as {
        collection: `0x${string}`
        wrapper: `0x${string}`
        pair: `0x${string}`
        baseToken: `0x${string}`
      }
      const buyQuote = await snf.quoteBuy({ chainId: 4663, collection: fixtures.collection, count: 1 })
      const tokenId = buyQuote.tokenIds![0]!

      const quote = await snf.quoteSell({ chainId: 4663, collection: fixtures.collection, tokenIds: [tokenId] })
      expect(quote.reconciled).toBe(true)

      const routerAnswer = await publicClient.readContract({
        address: ROBINHOOD_LANE!.fixtures['router02'] as `0x${string}`,
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
      const fixtures = ROBINHOOD_LANE!.fixtures as { wrapper: `0x${string}`; baseToken: `0x${string}` }
      const factory = '0x85039B2e95558aDdCCf4379728b8433C447E37bE' as `0x${string}`
      const isDelegated = await publicClient.readContract({
        address: factory,
        abi: FACTORY_ABI,
        functionName: 'delegates',
        args: [fixtures.wrapper, fixtures.baseToken],
      })
      // FINDING (Task 2 point 5, A2 — see , Findings, for the
      // full account): probed every registered wrapper on this chain (via the
      // snf-robinhood subgraph's `currencies(where:{wrapping:true})`, 2 entries)
      // against `Factory.delegates(...)` this session — every probe returned
      // `false`. No delegated pair currently exists on Robinhood Chain through the
      // SnF Factory, so the registry's `delegateNetFee: 9970` for this chain remains
      // UNVERIFIED against live bytecode (the registry's own comment cites
      // "verified empirically via router.getAmountsOut()" — a claim from a prior
      // session this one could not independently reproduce, since no live delegated
      // pair exists to query). Reported, not silently passed.
      expect(isDelegated).toBe(false)
    })
  })
})
