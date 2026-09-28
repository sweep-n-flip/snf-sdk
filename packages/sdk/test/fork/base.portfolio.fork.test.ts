import { createPublicClient, createWalletClient, defineChain, formatUnits, http } from 'viem'
import type { Chain, PublicClient, WalletClient } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createSnfClient } from '../../src/client'
import { isAddressLike } from '../../src/collection'
import { ERC20_ABI } from '../../src/abis/ERC20'
import type { SnfClient } from '../../src/types/client.types'

import { FORK_LANES, anvilMissingMessage, resolveAnvilBinary, startAnvil } from './anvil'
import type { AnvilInstance } from './anvil'
import { readPairState, sendPlanSteps } from './baseLiquidityHelpers'

/**
 * The Base PORTFOLIO fork lane — proves `positions`/`wnftBalances` against real, mined
 * Base fork state: a fresh key buys DEMON and adds it to the live ETH/DEMON pool
 * through this package's own plans, and both portfolio reads are checked against the
 * same loaders `lpPosition`/`readPairState` already use, at the same block, with no
 * transaction sent in between a portfolio read and its comparison read.
 *
 * SAFETY — fresh, randomly-generated keys only, funded via `anvil_setBalance`, local
 * fork only. Every `createWalletClient`/`sendTransaction` in this file targets
 * `anvil.url` (`127.0.0.1`) exclusively — see `base.liquidity.fork.test.ts`'s own
 * header comment for why a well-known anvil mnemonic account is never reused here.
 *
 * The pool set (`nftPoolSet`) both portfolio methods scan is read from the LIVE public
 * subgraph while the chain itself is the local fork — a real Base pool created after
 * the fork block therefore has no bytecode at this fork's pinned block and lands in
 * `positions()`'s own `skipped` list as `NO_ROUTE`. That is expected, asserted below,
 * not a bug.
 */

const BASE_LANE = FORK_LANES.find((l) => l.key === 'base')
if (!BASE_LANE) throw new Error('base lane missing from chains.fork.json')

const anvilBin = resolveAnvilBinary()
const describeOrSkip = anvilBin ? describe : describe.skip
if (!anvilBin) {
  // eslint-disable-next-line no-console
  console.warn(anvilMissingMessage())
}

const FUND_AMOUNT_WEI = 100n * 10n ** 18n // 100 ETH — this fork's own local balance, never real funds
const NATIVE_USD_PRICE = 2500
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const

const PAYER_ACCOUNT = privateKeyToAccount(generatePrivateKey())
const PAYER_ADDRESS = PAYER_ACCOUNT.address

/** `anvil_setBalance` — a fork-local debug RPC method, never touches a public chain. */
async function setLocalBalance(publicClient: PublicClient, address: `0x${string}`, wei: bigint): Promise<void> {
  await publicClient.transport.request({
    method: 'anvil_setBalance',
    params: [address, `0x${wei.toString(16)}`],
  })
}

interface BasePortfolioFixtures {
  readonly pair: `0x${string}`
  readonly wrapper: `0x${string}`
  readonly collection: `0x${string}`
  readonly sampleTokenIds: readonly string[]
}
const FIXTURES = BASE_LANE.fixtures as unknown as BasePortfolioFixtures

describeOrSkip(`Base PORTFOLIO fork lane (chainId ${BASE_LANE.chainId}, block ${BASE_LANE.forkBlockNumber})`, () => {
  let anvil: AnvilInstance
  let chain: Chain
  let publicClient: PublicClient
  let snf: SnfClient
  let snfPriced: SnfClient
  let payer: WalletClient

  beforeAll(async () => {
    anvil = await startAnvil(BASE_LANE!)
    chain = defineChain({
      id: anvil.chainId,
      name: 'base-portfolio-fork',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [anvil.url] } },
    })
    // `cacheTime: 0` — same reason as `base.liquidity.fork.test.ts`: without it, a read
    // right after this lane mines a transaction can see a stale, pre-mined block number.
    publicClient = createPublicClient({ chain, transport: http(anvil.url), cacheTime: 0 })
    snf = createSnfClient({ chainId: 8453, publicClient })
    snfPriced = createSnfClient({
      chainId: 8453,
      publicClient,
      providers: { prices: { getNativeUsd: () => Promise.resolve(NATIVE_USD_PRICE) } },
    })
    payer = createWalletClient({ account: PAYER_ACCOUNT, chain, transport: http(anvil.url) })
    await setLocalBalance(publicClient, PAYER_ADDRESS, FUND_AMOUNT_WEI)
  }, 60_000)

  afterAll(async () => {
    await anvil?.stop()
  })

  it('1. buys 3 DEMON with ETH and adds them to ETH/DEMON — funds the position the rest of this lane reads', async () => {
    const ids = FIXTURES.sampleTokenIds.slice(0, 3)

    const buyQuote = await snf.quoteBuy({ chainId: 8453, collection: FIXTURES.collection, tokenIds: ids })
    const buyPlan = await snf.buildBuy({ quote: buyQuote, recipient: PAYER_ADDRESS })
    const buyPreflight = await buyPlan.preflight()
    expect(buyPreflight.ok).toBe(true)
    const [buyReceipt] = await sendPlanSteps(payer, publicClient, chain, buyPlan)
    expect(buyReceipt!.status).toBe('success')

    const addQuote = await snf.quoteAddLiquidity({ chainId: 8453, collection: FIXTURES.collection, tokenIds: ids })
    const addPlan = await snf.buildAddLiquidity({ quote: addQuote, recipient: PAYER_ADDRESS })
    const addReceipts = await sendPlanSteps(payer, publicClient, chain, addPlan)
    const addReceipt = addReceipts[addReceipts.length - 1]!
    expect(addReceipt.status).toBe('success')

    const lpBalance = await publicClient.readContract({
      address: FIXTURES.pair,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [PAYER_ADDRESS],
    })
    expect((lpBalance as bigint) > 0n).toBe(true)
  }, 60_000)

  it('2. positions(payer) on a no-providers client matches lpPosition(pair, payer) exactly, mid-valued, no USD', async () => {
    const result = await snf.positions(PAYER_ADDRESS)
    expect(result.positions).toHaveLength(1)
    const entry = result.positions.find((p) => p.pair.toLowerCase() === FIXTURES.pair.toLowerCase())
    expect(entry).toBeDefined()

    // Every skipped entry is a real Base pool created after this fork's pinned block —
    // no bytecode exists for it at the block anvil forked from. Not a bug (see header).
    const skippedCodes = await Promise.all(
      result.skipped.map((skip) => publicClient.getCode({ address: skip.pair, blockNumber: result.blockNumber })),
    )
    for (const code of skippedCodes) {
      expect(code === undefined || code === '0x').toBe(true)
    }
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        purpose: 'positions() skipped-pair accounting (no-bytecode-at-fork-block)',
        forkBlockUsed: BASE_LANE!.forkBlockNumber,
        totalSkipped: result.skipped.length,
        blockNumber: result.blockNumber.toString(),
      }),
    )

    // No transaction sent between this read and the one below — same block.
    const direct = await snf.lpPosition(FIXTURES.pair, PAYER_ADDRESS)
    expect(entry!.lpBalance).toEqual(direct.lpBalance)
    expect(entry!.totalSupply).toEqual(direct.totalSupply)
    expect(entry!.shareBps).toEqual(direct.shareBps)
    expect(entry!.underlying).toEqual(direct.underlying)

    expect(entry!.valueInBase.value).toBe(2n * entry!.underlying.base.value)
    expect(entry!.valuation).toBe('mid')
    expect(entry!.valueUsd).toBeUndefined()
    expect(isAddressLike(entry!.labels.name)).toBe(false)
  }, 60_000)

  it('3. the same position, read through a prices-configured client, carries a USD mark at the configured native price', async () => {
    const result = await snfPriced.positions(PAYER_ADDRESS)
    const entry = result.positions.find((p) => p.pair.toLowerCase() === FIXTURES.pair.toLowerCase())
    expect(entry).toBeDefined()
    expect(entry!.valueUsd).toBe(Number(formatUnits(entry!.valueInBase.value, 18)) * NATIVE_USD_PRICE)
  }, 60_000)

  it("4. a 100% wnft-mode withdrawal: wnftBalances(payer) matches the wrapper's own balanceOf and the pair's live mid price", async () => {
    const quote = await snf.quoteRemoveLiquidity({
      chainId: 8453,
      pair: FIXTURES.pair,
      owner: PAYER_ADDRESS,
      bps: 10_000,
      mode: 'wnft',
    })
    const plan = await snf.buildRemoveLiquidity({ quote, recipient: PAYER_ADDRESS })
    const receipts = await sendPlanSteps(payer, publicClient, chain, plan)
    const removeReceipt = receipts[receipts.length - 1]!
    expect(removeReceipt.status).toBe('success')

    const result = await snf.wnftBalances(PAYER_ADDRESS)
    expect(result.holdings).toHaveLength(1)
    const holding = result.holdings[0]!
    expect(holding.wrapper.toLowerCase()).toBe(FIXTURES.wrapper.toLowerCase())

    const directBalance = (await publicClient.readContract({
      address: FIXTURES.wrapper,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [PAYER_ADDRESS],
    })) as bigint
    expect(holding.balance.value).toBe(directBalance)
    expect(holding.nftWhole).toBe(Number(directBalance / 10n ** 18n))

    // Same block — no transaction sent between the wnftBalances() read above and this
    // reserves read.
    const pairState = await readPairState(publicClient, FIXTURES.pair, FIXTURES.wrapper)
    expect(holding.valueInBase).toBeDefined()
    expect(holding.valueInBase!.value).toBe((directBalance * pairState.reserveBase) / pairState.reserveWnft)
  }, 60_000)

  it('5. positions(payer) no longer lists the fixture pair — the LP balance is now zero', async () => {
    const result = await snf.positions(PAYER_ADDRESS)
    const entry = result.positions.find((p) => p.pair.toLowerCase() === FIXTURES.pair.toLowerCase())
    expect(entry).toBeUndefined()
  }, 60_000)

  it('6. positions(0x0…0) — the permanently locked first-mint liquidity — every position has lpBalance === 1000', async () => {
    const result = await snf.positions(ZERO_ADDRESS)
    expect(result.positions.length).toBeGreaterThan(0)
    for (const p of result.positions) {
      expect(p.lpBalance.value).toBe(1000n)
    }
  }, 300_000)
})
