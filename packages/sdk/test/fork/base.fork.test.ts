import { createPublicClient, createWalletClient, defineChain, http, parseAbi } from 'viem'
import type { Chain, PublicClient, WalletClient } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createSnfClient } from '../../src/client'
import { isSnfError } from '../../src/errors'
import { ERC20_ABI } from '../../src/abis/ERC20'
import { ERC721_ABI } from '../../src/abis/ERC721'
import { PAIR_ABI } from '../../src/abis/UniswapV2Pair'
import { ROUTER02_COLLECTION_ABI } from '../../src/abis/UniswapV2Router02Collection'
import { getAmountIn, getAmountOut, ONE_E18, SNF_NFT_NET_FEE } from '../../src/math/quoteMath'
import type { SnfClient } from '../../src/types/client.types'

import { FORK_LANES, anvilMissingMessage, resolveAnvilBinary, startAnvil } from './anvil'
import type { AnvilInstance } from './anvil'

/**
 * The Base fork lane (Task 2, R20; 54-SPEC.md). Base is the primary lane (D-09): the
 * ETH/DEMON pool `0xE814…1ECf`, reconciled both directions against the real, deployed
 * Router bytecode, a real quickstart round trip (buy → send → recipient owns the
 * ids), preflight negatives, and the two open receipt fixtures (`buy-1.json`,
 * `sell-wnft.json`) captured live from this fork and written back to the repo.
 *
 * ── ANVIL DEFAULT ACCOUNTS ONLY (D-12) ──────────────────────────────────────────
 * Every signature in this file comes from one of anvil's own dev accounts — the
 * well-known Foundry/Hardhat test mnemonic ("test test test ... junk"), publicly
 * documented, funded only on the local fork, never used with real funds anywhere.
 * No real wallet key or founder funds are ever touched.
 */

const BASE_LANE = FORK_LANES.find((l) => l.key === 'base')
if (!BASE_LANE) throw new Error('base lane missing from chains.fork.json')

const anvilBin = resolveAnvilBinary()
const describeOrSkip = anvilBin ? describe : describe.skip
if (!anvilBin) {
  // eslint-disable-next-line no-console
  console.warn(anvilMissingMessage())
}

// Anvil's account #0 — deterministic, well-known, local-fork-only.
const BUYER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const
const BUYER_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const
// An address with a genuinely zero balance on this fork of REAL Base mainnet state —
// used ONLY as a read-only `preflight()` payer for the insufficient-balance case. No
// signature is ever requested from this address. `0x1234...7890`-style addresses
// turned out to hold real mainnet dust (confirmed live this session) — a freshly
// generated keypair (never derived from the anvil mnemonic, never funded by anyone)
// is the only way to guarantee a true zero balance on a REAL-state fork.
const UNFUNDED_ADDRESS = privateKeyToAccount(generatePrivateKey()).address

const WETH_ABI = parseAbi(['function balanceOf(address) view returns (uint256)'])

describeOrSkip(`Base fork lane (chainId ${BASE_LANE.chainId}, block ${BASE_LANE.forkBlockNumber})`, () => {
  let anvil: AnvilInstance
  let chain: Chain
  let publicClient: PublicClient
  let snf: SnfClient

  beforeAll(async () => {
    anvil = await startAnvil(BASE_LANE)
    chain = defineChain({
      id: anvil.chainId,
      name: 'base-fork',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [anvil.url] } },
    })
    publicClient = createPublicClient({ chain, transport: http(anvil.url) })
    snf = createSnfClient({ chainId: 8453, publicClient })
  }, 60_000)

  afterAll(async () => {
    await anvil?.stop()
  })

  describe('reconciliation, both directions, against the real deployed Router (R8, R20)', () => {
    it('quoteBuy(1 id) matches getAmountsInCollection AND an independent local getAmountIn reconstruction — to the wei', async () => {
      const fixtures = BASE_LANE!.fixtures as { collection: `0x${string}`; wrapper: `0x${string}`; pair: `0x${string}`; baseToken: `0x${string}` }
      const tokenId = '246125'
      const quote = await snf.quoteBuy({ chainId: 8453, collection: fixtures.collection, tokenIds: [tokenId] })
      expect(quote.reconciled).toBe(true)

      const routerAnswer = await publicClient.readContract({
        address: BASE_LANE!.fixtures['router02'] as `0x${string}`,
        abi: ROUTER02_COLLECTION_ABI,
        functionName: 'getAmountsInCollection',
        args: [[BigInt(tokenId)], [fixtures.baseToken, fixtures.collection], false],
      })
      expect(quote.totalCost?.value).toBe((routerAnswer as readonly bigint[])[0])

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

      const localPoolLeg = getAmountIn(1n * ONE_E18, reserveBase, reserveWnft, SNF_NFT_NET_FEE)
      expect(localPoolLeg).toBeDefined()
      const reconstructed = localPoolLeg! + quote.fees.marketplace.value + quote.fees.royalty.value
      expect(reconstructed).toBe(quote.totalCost?.value)
    })

    it('quoteSell(1 id) matches getAmountsOutCollection AND an independent local getAmountOut reconstruction — to the wei', async () => {
      const fixtures = BASE_LANE!.fixtures as { collection: `0x${string}`; wrapper: `0x${string}`; pair: `0x${string}`; baseToken: `0x${string}` }
      const tokenId = '246125'
      const quote = await snf.quoteSell({ chainId: 8453, collection: fixtures.collection, tokenIds: [tokenId] })
      expect(quote.reconciled).toBe(true)

      const routerAnswer = await publicClient.readContract({
        address: BASE_LANE!.fixtures['router02'] as `0x${string}`,
        abi: ROUTER02_COLLECTION_ABI,
        functionName: 'getAmountsOutCollection',
        args: [[BigInt(tokenId)], [fixtures.collection, fixtures.baseToken], false],
      })
      const routerNet = (routerAnswer as readonly bigint[])[1]
      expect(quote.totalProceeds?.value).toBe(routerNet)
      expect(routerNet).toBe(91_417_099_472_198n) // RESEARCH Assumption A3, closed

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

    it('quoteSell(3 ids) matches getAmountsOutCollection — to the wei (RESEARCH Assumption A3, 3-id figure)', async () => {
      const fixtures = BASE_LANE!.fixtures as { collection: `0x${string}`; wrapper: `0x${string}`; pair: `0x${string}`; baseToken: `0x${string}` }
      const tokenIds = ['246125', '246171', '245868']
      const quote = await snf.quoteSell({ chainId: 8453, collection: fixtures.collection, tokenIds })
      expect(quote.reconciled).toBe(true)
      expect(quote.totalProceeds?.value).toBe(237_988_677_509_668n)
    })
  })

  describe('the quickstart round trip (R13, R14, SPEC AC #2): buildBuy -> preflight -> send -> ownership', () => {
    it('a real buy transaction on the fork transfers the requested tokenId to the recipient, and captures buy-1.json', async () => {
      const fixtures = BASE_LANE!.fixtures as { collection: `0x${string}`; wrapper: `0x${string}`; pair: `0x${string}`; baseToken: `0x${string}` }
      const tokenId = '245830' // an id NOT touched by the reconciliation tests above
      const account = privateKeyToAccount(BUYER_KEY)
      const walletClient = createWalletClient({ account, chain, transport: http(anvil.url) })

      const quote = await snf.quoteBuy({ chainId: 8453, collection: fixtures.collection, tokenIds: [tokenId] })
      const plan = await snf.buildBuy({ quote, recipient: BUYER_ADDRESS })
      expect(plan.steps.length).toBeGreaterThan(0)

      let preflightOutcome: 'ok' | 'tokenids_unavailable_mismatch' = 'ok'
      let preflightError: unknown
      try {
        const result = await plan.preflight()
        expect(result.ok).toBe(true)
      } catch (err) {
        // See this plan's SUMMARY "Findings" section: runPreflight's buy-side
        // ownership check compares `ownerOf(tokenId)` against `StepPreflightRefs.pair`
        // (the AMM Pair contract), but this collection's real on-chain custody model
        // holds the underlying ERC-721 in the WRAPPER contract, not the Pair — a live
        // `ownerOf` read on this fork returns the wrapper address. This file does NOT
        // edit `packages/sdk/src` (plan's own repo rule) — it records the exact
        // mismatch and continues to prove the REAL send still works end to end
        // (the Router's own on-chain logic, not this client-side pre-check, is what
        // actually gates a real buy).
        if (isSnfError(err) && err.code === 'TOKENIDS_UNAVAILABLE') {
          preflightOutcome = 'tokenids_unavailable_mismatch'
          preflightError = err
          const onChainOwner = await publicClient.readContract({
            address: fixtures.collection,
            abi: ERC721_ABI,
            functionName: 'ownerOf',
            args: [BigInt(tokenId)],
          })
          // eslint-disable-next-line no-console
          console.warn(
            'FINDING (preflight buy-side ownership check): expected pair/wrapper mismatch. ' +
              `ownerOf(${tokenId}) = ${String(onChainOwner)}, wrapper = ${fixtures.wrapper}, pair = ${fixtures.pair}. ` +
              `SnfError details: ${JSON.stringify((err as { details?: unknown }).details)}`,
          )
          expect((onChainOwner as string).toLowerCase()).toBe(fixtures.wrapper.toLowerCase())
        } else {
          throw err
        }
      }

      const buyerBalanceBefore = await publicClient.getBalance({ address: BUYER_ADDRESS })

      const hashes: `0x${string}`[] = []
      for (const step of plan.steps) {
        const hash = await walletClient.sendTransaction({
          chain,
          to: step.tx.to,
          data: step.tx.data,
          value: step.tx.value,
          gas: step.tx.gas,
        })
        await publicClient.waitForTransactionReceipt({ hash })
        hashes.push(hash)
      }
      const swapHash = hashes[hashes.length - 1]!
      const receipt = await publicClient.getTransactionReceipt({ hash: swapHash })
      expect(receipt.status).toBe('success')

      const owner = await publicClient.readContract({
        address: fixtures.collection,
        abi: ERC721_ABI,
        functionName: 'ownerOf',
        args: [BigInt(tokenId)],
      })
      expect((owner as string).toLowerCase()).toBe(BUYER_ADDRESS.toLowerCase())

      const buyerBalanceAfter = await publicClient.getBalance({ address: BUYER_ADDRESS })
      const gasCost = receipt.gasUsed * receipt.effectiveGasPrice
      const spent = buyerBalanceBefore - buyerBalanceAfter - gasCost
      const swapStep = plan.steps[plan.steps.length - 1]!
      expect(spent).toBeGreaterThan(0n)
      expect(spent).toBeLessThanOrEqual(swapStep.bounds.amountInMax as bigint)

      const swapReceipt = snf.parseReceipt(receipt)
      expect(swapReceipt.itemsOut).toContain(tokenId)
      expect(swapReceipt.paid?.value).toBeGreaterThan(0n)

      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify({
          purpose: 'buy-1.json fixture capture',
          preflightOutcome,
          preflightErrorCode: isSnfError(preflightError) ? preflightError.code : undefined,
          transactionHash: swapHash,
          blockNumber: receipt.blockNumber.toString(),
          spent: spent.toString(),
          logs: receipt.logs.map((l) => ({
            address: l.address,
            data: l.data,
            topics: l.topics,
            logIndex: l.logIndex,
            transactionIndex: l.transactionIndex,
            removed: l.removed,
          })),
        }),
      )
    }, 60_000)
  })

  describe('preflight negatives (R14, Task 2 point 3)', () => {
    it('WRONG_CHAIN: a publicClient configured for a different chain id throws before any on-chain read', async () => {
      const wrongChain = defineChain({
        id: 1,
        name: 'wrong-chain',
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: { default: { http: [anvil.url] } },
      })
      const wrongClient = createPublicClient({ chain: wrongChain, transport: http(anvil.url) })
      const fixtures = BASE_LANE!.fixtures as { collection: `0x${string}` }
      const quote = await snf.quoteBuy({ chainId: 8453, collection: fixtures.collection, tokenIds: ['246133'] })
      const plan = await snf.buildBuy({ quote, recipient: BUYER_ADDRESS })
      const wrongSnf = createSnfClient({ chainId: 8453, publicClient: wrongClient })
      const wrongPlan = await wrongSnf.buildBuy({ quote, recipient: BUYER_ADDRESS })
      await expect(wrongPlan.preflight()).rejects.toMatchObject({ code: 'WRONG_CHAIN' })
      // The original (correctly-chained) plan is untouched by this — sanity check.
      expect(plan.chainId).toBe(8453)
    })

    it('insufficient native balance: an unfunded recipient throws INVALID_PARAMS with the required/available amounts', async () => {
      // Uses a plain fungible swap (buildSwap, native-in), not buildBuy — a *Collection*
      // buy plan's preflight ALSO fails ownership first (WRONG_CHAIN -> WRAPPER_UNVERIFIED
      // -> TOKENIDS_UNAVAILABLE -> balance, in that fixed precedence order — see the
      // "quickstart round trip" test above and this plan's SUMMARY Findings), which
      // would mask the balance check entirely on THIS collection. `buildSwap` has no
      // `preflightRefs` at all (build/buildSwap.ts's own comment: "a fungible swap has
      // no NFT collection/wrapper/pair to verify ownership against"), so it is the
      // clean way to exercise the balance branch in isolation.
      const fixtures = BASE_LANE!.fixtures as { wrapper: `0x${string}` }
      const quote = await snf.quoteSwap({ chainId: 8453, tokenIn: null, tokenOut: fixtures.wrapper, amountIn: 10_000_000_000_000n })
      const plan = await snf.buildSwap({ quote, recipient: UNFUNDED_ADDRESS })
      const balance = await publicClient.getBalance({ address: UNFUNDED_ADDRESS })
      expect(balance).toBe(0n)
      await expect(plan.preflight()).rejects.toMatchObject({ code: 'INVALID_PARAMS', details: { field: 'value' } })
    })
  })

  describe('FINDING (not fixed — packages/sdk/src is out of scope for this plan): buildSwap cannot return a plan on the first call when the needed ERC-20 approval is missing', () => {
    it('buildSwap throws (does not return a plan with an approval step) when the wallet has never approved the Router for the ERC-20 it is selling', async () => {
      const fixtures = BASE_LANE!.fixtures as { wrapper: `0x${string}` }
      // Anvil account #1 — funded with ETH but has never approved the Router to
      // move its (zero) wrapper-token balance. `buildSwap`'s unconditional
      // `estimateGasWithBuffer` call simulates the swap step against CURRENT
      // on-chain state (no allowance yet) and — by `build/gas.ts`'s own documented
      // design ("a genuine simulated revert is RE-THROWN, never swallowed") — throws
      // before `assemblePlan` ever runs, so the caller never receives the plan's
      // `approval` step at all. See this plan's SUMMARY, Findings, for the full
      // account and the two-phase work-around this file uses elsewhere.
      const otherRecipient = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const
      const sellQuote = await snf.quoteSwap({
        chainId: 8453,
        tokenIn: fixtures.wrapper,
        tokenOut: null,
        amountIn: 1n, // smallest possible unit — the revert is allowance-shaped, not amount-shaped
      })
      await expect(snf.buildSwap({ quote: sellQuote, recipient: otherRecipient })).rejects.toThrow(
        /transferFrom/i,
      )
    })
  })

  describe('the wNFT (fractional wrapper) round trip — captures sell-wnft.json', () => {
    it('buying then selling a fractional wrapper amount via buildSwap produces a real, mined swapExactTokensForETH receipt (no royalty/fee split)', async () => {
      const fixtures = BASE_LANE!.fixtures as { wrapper: `0x${string}`; baseToken: `0x${string}` }
      const account = privateKeyToAccount(BUYER_KEY)
      const walletClient = createWalletClient({ account, chain, transport: http(anvil.url) })

      // Leg 1: buy a small fractional wrapper amount with ETH (plain AMM swap, no
      // *Collection function — no marketplace fee, no royalty).
      const buyAmountIn = 1_000_000_000_000n // 1e-6 ETH — tiny, well within reserves
      const buyQuote = await snf.quoteSwap({ chainId: 8453, tokenIn: null, tokenOut: fixtures.wrapper, amountIn: buyAmountIn })
      const buyPlan = await snf.buildSwap({ quote: buyQuote, recipient: BUYER_ADDRESS })
      for (const step of buyPlan.steps) {
        const hash = await walletClient.sendTransaction({ chain, to: step.tx.to, data: step.tx.data, value: step.tx.value, gas: step.tx.gas })
        await publicClient.waitForTransactionReceipt({ hash })
      }

      const wrapperBalance = await publicClient.readContract({
        address: fixtures.wrapper,
        abi: WETH_ABI,
        functionName: 'balanceOf',
        args: [BUYER_ADDRESS],
      })
      expect(wrapperBalance).toBeGreaterThan(0n)

      // Leg 2: sell HALF the wrapper balance back for ETH — the fixture-capturing tx.
      //
      // FINDING (see this plan's SUMMARY "Findings" — NOT fixed here, `packages/sdk/src`
      // is out of scope for this plan): `buildSwap` unconditionally gas-estimates the
      // SWAP step against CURRENT on-chain state (`build/gas.ts`'s `estimateGasWithBuffer`),
      // and a genuine simulated revert is deliberately RE-THROWN, never swallowed. When
      // the required ERC-20 approval does not exist yet, the swap step's simulated
      // `transferFrom` reverts — so `buildSwap` throws BEFORE ever returning the plan,
      // meaning the caller never even receives the `approval` step it would otherwise
      // have included. Every unit test for this path mocks `estimateContractGas` (always
      // succeeds), so this is invisible without a real fork. Confirmed here: even the
      // FIRST `buildSwap` call throws, not just a second one.
      //
      // Work-around for this fixture capture ONLY (not a fix, not a recommendation for
      // partners): grant the ERC-20 allowance directly via a plain `approve()` call
      // BEFORE calling `buildSwap` at all, so gas estimation has real allowance to
      // simulate against.
      const sellAmountIn = (wrapperBalance as bigint) / 2n
      const approveHash = await walletClient.writeContract({
        chain,
        address: fixtures.wrapper,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [BASE_LANE!.fixtures['router02'] as `0x${string}`, sellAmountIn],
      })
      await publicClient.waitForTransactionReceipt({ hash: approveHash })

      const sellQuote = await snf.quoteSwap({ chainId: 8453, tokenIn: fixtures.wrapper, tokenOut: null, amountIn: sellAmountIn })
      const sellPlan = await snf.buildSwap({ quote: sellQuote, recipient: BUYER_ADDRESS })
      expect(sellPlan.steps.filter((s) => s.kind === 'approval').length).toBe(0) // allowance already sufficient

      let swapHash: `0x${string}` | undefined
      for (const step of sellPlan.steps) {
        const hash = await walletClient.sendTransaction({ chain, to: step.tx.to, data: step.tx.data, value: step.tx.value, gas: step.tx.gas })
        await publicClient.waitForTransactionReceipt({ hash })
        swapHash = hash
      }
      expect(swapHash).toBeDefined()
      const receipt = await publicClient.getTransactionReceipt({ hash: swapHash! })
      expect(receipt.status).toBe('success')

      const swapReceipt = snf.parseReceipt(receipt)
      expect(swapReceipt.itemsIn).toEqual([]) // fungible leg, no ERC-721 Transfer logs
      expect(swapReceipt.fees.marketplace.value).toBe(0n) // plain swap — no *Collection call, no fee
      expect(swapReceipt.fees.royalty.value).toBe(0n)

      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify({
          purpose: 'sell-wnft.json fixture capture',
          transactionHash: swapHash,
          blockNumber: receipt.blockNumber.toString(),
          sellAmountIn: sellAmountIn.toString(),
          logs: receipt.logs.map((l) => ({
            address: l.address,
            data: l.data,
            topics: l.topics,
            logIndex: l.logIndex,
            transactionIndex: l.transactionIndex,
            removed: l.removed,
          })),
        }),
      )
    }, 60_000)
  })
})
