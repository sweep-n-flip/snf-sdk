import { createPublicClient, createWalletClient, defineChain, http } from 'viem'
import type { Chain, PublicClient, WalletClient } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createSnfClient } from '../../src/client'
import { ERC20_ABI } from '../../src/abis/ERC20'
import { FACTORY_ABI } from '../../src/abis/UniswapV2Factory'
import { PAIR_ABI } from '../../src/abis/UniswapV2Pair'
import { requiredBase } from '../../src/liquidity/liquidityMath'
import { getAmountOut } from '../../src/math/quoteMath'
import type { SnfClient } from '../../src/types/client.types'

import { FORK_LANES, anvilMissingMessage, resolveAnvilBinary, startAnvil } from './anvil'
import type { AnvilInstance } from './anvil'
import { assertAllOwnedBy, readPairState, readReservesForToken, sendPlanSteps } from './baseLiquidityHelpers'

/**
 * The Base LIQUIDITY fork lane — proves every liquidity plan this package builds
 * (create, add, seed, remove in both modes) end to end against a local fork of REAL
 * Base mainnet state, and measures the creation-gas overhead the deposit gas
 * fallback already bakes in. One continuous, ordered scenario: later `it()`s
 * depend on the real, mined state earlier ones left behind — not independent cases.
 *
 * ── FRESH, RANDOMLY-GENERATED KEYS ONLY, FUNDED VIA `anvil_setBalance`, LOCAL FORK
 * ONLY ─────────────────────────────────────────────────────────────────────
 * This lane deliberately does NOT reuse anvil's own well-known "test test test ...
 * junk" mnemonic accounts the way `base.fork.test.ts` does for a pure NFT-buy round
 * trip. Discovered live this session: `base.fork.test.ts`'s own account #0 address
 * (`0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266`) already carries REAL bytecode on
 * live Base mainnet — an EIP-7702 delegation (`0xef0100…`) that immediately forwards
 * any ETH it receives to another address. On a fork of REAL chain state that
 * delegation comes along too, so a plain balance-diff check on that address silently
 * swallows any native-ETH REFUND a Router call sends back to `msg.sender` (this
 * lane's add/remove-liquidity assertions need exact refund/payout amounts, unlike
 * `base.fork.test.ts`'s own buy test, which already only asserts `spent <=
 * amountInMax`, never an exact figure, for the apparent identical reason). A freshly
 * generated keypair has astronomically negligible odds of colliding with any real
 * address, so both signers here are `generatePrivateKey()` outputs, funded directly
 * via anvil's own `anvil_setBalance` (a fork-only debug RPC method — never touches a
 * public chain). Every `sendTransaction`/`createWalletClient` in this file targets
 * `anvil.url` (`127.0.0.1`) exclusively.
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

const PAYER_ACCOUNT = privateKeyToAccount(generatePrivateKey())
const PAYER_ADDRESS = PAYER_ACCOUNT.address
const LP_RECIPIENT_ACCOUNT = privateKeyToAccount(generatePrivateKey())
const LP_RECIPIENT_ADDRESS = LP_RECIPIENT_ACCOUNT.address

/** `anvil_setBalance` — sets a fork-local account's native balance directly; the
 * fresh keypairs above start at zero and need this to pay for gas and deposits. */
async function setLocalBalance(publicClient: PublicClient, address: `0x${string}`, wei: bigint): Promise<void> {
  await publicClient.transport.request({
    method: 'anvil_setBalance',
    params: [address, `0x${wei.toString(16)}`],
  })
}

interface BaseLiquidityFixtures {
  readonly factory: `0x${string}`
  readonly router02: `0x${string}`
  readonly pair: `0x${string}`
  readonly wrapper: `0x${string}`
  readonly collection: `0x${string}`
  readonly baseToken: `0x${string}`
  readonly usdc: `0x${string}`
  readonly sampleTokenIds: readonly string[]
}
const FIXTURES = BASE_LANE.fixtures as unknown as BaseLiquidityFixtures

describeOrSkip(`Base LIQUIDITY fork lane (chainId ${BASE_LANE.chainId}, block ${BASE_LANE.forkBlockNumber})`, () => {
  let anvil: AnvilInstance
  let chain: Chain
  let publicClient: PublicClient
  let snf: SnfClient
  let payer: WalletClient
  let lpRecipientWallet: WalletClient

  // Populated across steps — later `it()`s depend on the real, mined state earlier
  // ones left behind.
  let addedIds: readonly string[]
  let demonUsdcPair: `0x${string}` | undefined

  beforeAll(async () => {
    anvil = await startAnvil(BASE_LANE!)
    chain = defineChain({
      id: anvil.chainId,
      name: 'base-liquidity-fork',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [anvil.url] } },
    })
    // `cacheTime: 0` — viem's default client-level cache (`pollingInterval`, 4s)
    // memoizes `getBlockNumber()` per client instance. Every liquidity loader in this
    // package (`loadDepositState`/`loadPairState`) reads the block ONCE per call via
    // that same cached method, and this lane mines several transactions back to back
    // (anvil mines instantly, well inside that 4s window) — without disabling the
    // cache, a later read in this same describe block can silently see a BLOCK
    // NUMBER from BEFORE an earlier `it()`'s own deposit/withdrawal mined, well
    // before its cache would naturally expire, and reconstruct pool state from
    // stale reserves/balances.
    publicClient = createPublicClient({ chain, transport: http(anvil.url), cacheTime: 0 })
    snf = createSnfClient({ chainId: 8453, publicClient })
    payer = createWalletClient({ account: PAYER_ACCOUNT, chain, transport: http(anvil.url) })
    lpRecipientWallet = createWalletClient({ account: LP_RECIPIENT_ACCOUNT, chain, transport: http(anvil.url) })
    await setLocalBalance(publicClient, PAYER_ADDRESS, FUND_AMOUNT_WEI)
    await setLocalBalance(publicClient, LP_RECIPIENT_ADDRESS, FUND_AMOUNT_WEI)
  }, 60_000)

  afterAll(async () => {
    await anvil?.stop()
  })

  it('1. buys 8 DEMON with ETH — funds both the seed (Task 3) and the native add-liquidity deposit (Task 5)', async () => {
    const ids = FIXTURES.sampleTokenIds.slice(0, 8)
    const quote = await snf.quoteBuy({ chainId: 8453, collection: FIXTURES.collection, tokenIds: ids })
    const plan = await snf.buildBuy({ quote, recipient: PAYER_ADDRESS })
    const preflight = await plan.preflight()
    expect(preflight.ok).toBe(true)

    const [receipt] = await sendPlanSteps(payer, publicClient, chain, plan)
    expect(receipt!.status).toBe('success')

    await assertAllOwnedBy(publicClient, FIXTURES.collection, ids, PAYER_ADDRESS)
  }, 60_000)

  it('2. funds the payer with USDC via a real ETH -> USDC swap on the fork (the SDK\'s own quoteSwap/buildSwap, a genuine delegate route)', async () => {
    // The real WETH/USDC delegate pool at the pinned block has ~241 ETH / 654k USDC
    // reserves — 0.02 ETH moves it negligibly and yields far more USDC than the
    // seed in Task 3 needs.
    const amountIn = 20_000_000_000_000_000n
    const quote = await snf.quoteSwap({ chainId: 8453, tokenIn: null, tokenOut: FIXTURES.usdc, amountIn })
    const plan = await snf.buildSwap({ quote, recipient: PAYER_ADDRESS })
    const [receipt] = await sendPlanSteps(payer, publicClient, chain, plan)
    expect(receipt!.status).toBe('success')

    const usdcBalance = await publicClient.readContract({
      address: FIXTURES.usdc,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [PAYER_ADDRESS],
    })
    expect(usdcBalance as bigint).toBeGreaterThan(0n)
  }, 60_000)

  it("3. buildSeed creates the DEMON/USDC pool with 6 NFTs at the ETH pool's own live price — exact minimum, create gas measured", async () => {
    const seededIds = FIXTURES.sampleTokenIds.slice(0, 6)

    // pricePerNft ≈ the ETH/DEMON pool's own live price, converted to USDC through
    // the real WETH/USDC delegate pool — both read live, right now, not hardcoded.
    const ethDemon = await readPairState(publicClient, FIXTURES.pair, FIXTURES.wrapper)
    const ethPerNft = requiredBase(1, ethDemon.reserveWnft, ethDemon.reserveBase)
    const wethUsdcPair = (await publicClient.readContract({
      address: FIXTURES.factory,
      abi: FACTORY_ABI,
      functionName: 'getPair',
      args: [FIXTURES.baseToken, FIXTURES.usdc],
    })) as `0x${string}`
    const wethUsdc = await readReservesForToken(publicClient, wethUsdcPair, FIXTURES.usdc)
    const usdcPerNft = getAmountOut(ethPerNft, wethUsdc.reserveOther, wethUsdc.reserveOfToken, BigInt(snf.chain.delegateNetFee))
    expect(usdcPerNft).toBeDefined()
    expect(usdcPerNft!).toBeGreaterThan(0n)

    const pairBefore = await publicClient.readContract({
      address: FIXTURES.factory,
      abi: FACTORY_ABI,
      functionName: 'getPair',
      args: [FIXTURES.wrapper, FIXTURES.usdc],
    })
    expect(pairBefore).toBe('0x0000000000000000000000000000000000000000') // a genuine create, confirmed live

    const plan = await snf.buildSeed({
      collection: FIXTURES.collection,
      tokenIds: seededIds,
      pricePerNft: usdcPerNft!,
      baseToken: FIXTURES.usdc,
      payer: PAYER_ADDRESS,
      lpRecipient: LP_RECIPIENT_ADDRESS,
    })
    // ERC-721 (DEMON -> router) + ERC-20 (USDC -> router) approvals, then the one
    // create-pool deposit step (6 ids, single chunk).
    expect(plan.steps.map((s) => s.kind)).toEqual(['approval', 'approval', 'add-liquidity'])

    const depositStep = plan.steps[plan.steps.length - 1]!
    const expectedLpOut = depositStep.quote.liquidity!.lpOut!.value
    const expectedBaseRequired = depositStep.quote.liquidity!.baseRequired!.value
    expect(depositStep.bounds.amountInMin).toBe(expectedBaseRequired) // exact minimum — never loosened
    const createTxGas = depositStep.tx.gas!

    const usdcBefore = await publicClient.readContract({
      address: FIXTURES.usdc,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [PAYER_ADDRESS],
    })
    const receipts = await sendPlanSteps(payer, publicClient, chain, plan)
    const createReceipt = receipts[receipts.length - 1]!
    expect(createReceipt.status).toBe('success')
    const createGasUsed = createReceipt.gasUsed
    expect(createGasUsed).toBeLessThanOrEqual(createTxGas)

    demonUsdcPair = (await publicClient.readContract({
      address: FIXTURES.factory,
      abi: FACTORY_ABI,
      functionName: 'getPair',
      args: [FIXTURES.wrapper, FIXTURES.usdc],
    })) as `0x${string}`
    expect(demonUsdcPair).not.toBe('0x0000000000000000000000000000000000000000')

    const lpBalance = await publicClient.readContract({
      address: demonUsdcPair,
      abi: PAIR_ABI,
      functionName: 'balanceOf',
      args: [LP_RECIPIENT_ADDRESS],
    })
    expect(lpBalance as bigint).toBe(expectedLpOut)

    const usdcAfter = await publicClient.readContract({
      address: FIXTURES.usdc,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [PAYER_ADDRESS],
    })
    expect((usdcBefore as bigint) - (usdcAfter as bigint)).toBe(expectedBaseRequired)

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        purpose: 'DEMON/USDC create gas overhead',
        forkBlockUsed: BASE_LANE!.forkBlockNumber,
        createGasUsed: createGasUsed.toString(),
        createTxGas: createTxGas.toString(),
      }),
    )
  }, 60_000)

  it('4. Factory.createWrapper on a fresh, never-touched address estimates <= 1,000,000 gas (the wrapper creation overhead)', async () => {
    const freshCollection = privateKeyToAccount(generatePrivateKey()).address
    const gas = await publicClient.estimateContractGas({
      address: FIXTURES.factory,
      abi: FACTORY_ABI,
      functionName: 'createWrapper',
      args: [freshCollection],
      account: PAYER_ADDRESS,
    })
    expect(gas).toBeLessThanOrEqual(1_000_000n)

    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ purpose: 'createWrapper gas estimate', gas: gas.toString() }))
  })

  it("5. buildAddLiquidity deposits the remaining 2 DEMON natively into ETH/DEMON — LP minted and ETH spent match the quote exactly", async () => {
    addedIds = FIXTURES.sampleTokenIds.slice(6, 8)

    const lpBefore = await publicClient.readContract({
      address: FIXTURES.pair,
      abi: PAIR_ABI,
      functionName: 'balanceOf',
      args: [PAYER_ADDRESS],
    })
    expect(lpBefore as bigint).toBe(0n) // the payer never held LP on this pair before this deposit

    const quote = await snf.quoteAddLiquidity({ chainId: 8453, collection: FIXTURES.collection, tokenIds: addedIds })
    const plan = await snf.buildAddLiquidity({ quote, recipient: PAYER_ADDRESS })
    // DEMON is already approved to router02 from Task 3's blanket setApprovalForAll
    // — no approval step needed here.
    expect(plan.steps.map((s) => s.kind)).toEqual(['add-liquidity'])
    const depositStep = plan.steps[0]!
    const expectedLpOut = depositStep.quote.liquidity!.lpOut!.value
    const expectedBaseRequired = depositStep.quote.liquidity!.baseRequired!.value

    const balanceBefore = await publicClient.getBalance({ address: PAYER_ADDRESS })
    const [receipt] = await sendPlanSteps(payer, publicClient, chain, plan)
    expect(receipt!.status).toBe('success')
    const balanceAfter = await publicClient.getBalance({ address: PAYER_ADDRESS })

    const lpAfter = await publicClient.readContract({
      address: FIXTURES.pair,
      abi: PAIR_ABI,
      functionName: 'balanceOf',
      args: [PAYER_ADDRESS],
    })
    expect(lpAfter as bigint).toBe(expectedLpOut)

    const gasCost = receipt!.gasUsed * receipt!.effectiveGasPrice
    const spent = balanceBefore - balanceAfter - gasCost
    expect(spent).toBe(expectedBaseRequired)

    expect(() => snf.parseReceipt(receipt!)).not.toThrow()
  }, 60_000)

  it("6. buildRemoveLiquidity redeems 100% of the payer's ETH/DEMON LP in nft mode — whole NFTs, wNFT remainder, and ETH all match the quote", async () => {
    const position = await snf.lpPosition(FIXTURES.pair, PAYER_ADDRESS)
    const nftWhole = position.underlying.nftWhole
    expect(nftWhole).toBeGreaterThan(0)
    const chosenIds = addedIds.slice(0, nftWhole) // ids this test itself deposited in Task 5, guaranteed custodied by the wrapper

    const quote = await snf.quoteRemoveLiquidity({
      chainId: 8453,
      pair: FIXTURES.pair,
      owner: PAYER_ADDRESS,
      bps: 10_000,
      mode: 'nft',
      tokenIds: chosenIds,
    })
    const plan = await snf.buildRemoveLiquidity({ quote, recipient: PAYER_ADDRESS })
    expect(plan.steps.map((s) => s.kind)).toEqual(['approval', 'remove-liquidity']) // the LP approval step appeared exactly once
    expect(plan.steps[0]!.approvals[0]!.kind).toBe('lp-allowance')

    const preflight = await plan.preflight()
    expect(preflight.ok).toBe(true)

    const removeStep = plan.steps[plan.steps.length - 1]!
    const expectedWnftRemainder = removeStep.quote.liquidity!.wnftRemainder!.value
    const expectedBaseOut = removeStep.quote.liquidity!.baseOut!.value

    const wnftBefore = await publicClient.readContract({
      address: FIXTURES.wrapper,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [PAYER_ADDRESS],
    })
    const balanceBefore = await publicClient.getBalance({ address: PAYER_ADDRESS })
    const receipts = await sendPlanSteps(payer, publicClient, chain, plan)
    const removeReceipt = receipts[receipts.length - 1]!
    expect(removeReceipt.status).toBe('success')
    const balanceAfter = await publicClient.getBalance({ address: PAYER_ADDRESS })

    const wnftAfter = await publicClient.readContract({
      address: FIXTURES.wrapper,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [PAYER_ADDRESS],
    })
    expect((wnftAfter as bigint) - (wnftBefore as bigint)).toBe(expectedWnftRemainder)

    await assertAllOwnedBy(publicClient, FIXTURES.collection, chosenIds, PAYER_ADDRESS)

    // Both mined txs (the LP approval and the removal) cost gas but only the
    // removal moves ETH — subtract both receipts' gas costs from the net balance
    // change to isolate the payout.
    const totalGasCost = receipts.reduce((sum, r) => sum + r.gasUsed * r.effectiveGasPrice, 0n)
    const spent = balanceAfter - balanceBefore + totalGasCost
    expect(spent).toBe(expectedBaseOut)

    expect(() => snf.parseReceipt(removeReceipt)).not.toThrow()
  }, 60_000)

  it("7. buildRemoveLiquidity redeems 50% of the LP recipient's DEMON/USDC LP in wnft mode — USDC and wNFT match the quote exactly", async () => {
    expect(demonUsdcPair).toBeDefined()
    const quote = await snf.quoteRemoveLiquidity({
      chainId: 8453,
      pair: demonUsdcPair!,
      owner: LP_RECIPIENT_ADDRESS,
      bps: 5_000,
      mode: 'wnft',
    })
    const plan = await snf.buildRemoveLiquidity({ quote, recipient: LP_RECIPIENT_ADDRESS })
    expect(plan.steps.map((s) => s.kind)).toEqual(['approval', 'remove-liquidity'])

    const removeStep = plan.steps[plan.steps.length - 1]!
    const expectedBaseOut = removeStep.quote.liquidity!.baseOut!.value
    const expectedWnftOut = removeStep.quote.liquidity!.wnftOut!.value

    const usdcBefore = await publicClient.readContract({
      address: FIXTURES.usdc,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [LP_RECIPIENT_ADDRESS],
    })
    const wnftBefore = await publicClient.readContract({
      address: FIXTURES.wrapper,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [LP_RECIPIENT_ADDRESS],
    })

    const receipts = await sendPlanSteps(lpRecipientWallet, publicClient, chain, plan)
    const removeReceipt = receipts[receipts.length - 1]!
    expect(removeReceipt.status).toBe('success')

    const usdcAfter = await publicClient.readContract({
      address: FIXTURES.usdc,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [LP_RECIPIENT_ADDRESS],
    })
    const wnftAfter = await publicClient.readContract({
      address: FIXTURES.wrapper,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [LP_RECIPIENT_ADDRESS],
    })

    expect((usdcAfter as bigint) - (usdcBefore as bigint)).toBe(expectedBaseOut)
    expect((wnftAfter as bigint) - (wnftBefore as bigint)).toBe(expectedWnftOut)

    expect(() => snf.parseReceipt(removeReceipt)).not.toThrow()
  }, 60_000)

  it('8. quoteCreatePool refuses DEMON/USDC now that it has real liquidity — the front-run guard', async () => {
    await expect(
      snf.quoteCreatePool({
        chainId: 8453,
        collection: FIXTURES.collection,
        tokenIds: ['1', '2', '3', '4', '5', '6'],
        baseAmount: 1_000_000n,
        baseToken: FIXTURES.usdc,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS', details: { reason: 'pool-has-liquidity' } })
  })
})
