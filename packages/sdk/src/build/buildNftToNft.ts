import { encodeFunctionData } from 'viem'
import type { Abi } from 'viem'

import { ROUTER02_COLLECTION_ABI } from '../abis/UniswapV2Router02Collection'
import { ROUTER_NATIVE_ERC20_ABI } from '../abis/UniswapV2Router01CollectionNativeERC20'
import { toNativeValue } from '../chains/units'
import { assertParam, SnfError } from '../errors'
import { buildWnftRoutePath } from '../routing/nftRoutePaths'
import { quoteNftToNft } from '../quote/quoteNftToNft'
import { buildApprovalStep, missingApprovals } from './approvals'
import { deriveBounds } from './bounds'
import { resolveGasForStep } from './gas'
import { assemblePlan } from './plan'
import { validateBuildArgs } from './validate'
import type { SnfClientContext } from '../types/client.types'
import type { Approval, BuildArgs, ExecutionPlan, Step } from '../types/plan.types'
import type { QuoteLeg } from '../types/quote.types'

/**
 * `buildNftToNft` — the two-or-three-step, USER-DRIVEN `ExecutionPlan` for an NFT×NFT
 * swap. This is TWO OR THREE SEPARATE TRANSACTIONS the user
 * initiates, never one flow the SDK drives: `[approval(sell)?, swap-sell, swap-buy,
 * swap-buy-wnft?]`. Each on-chain transaction maps to a discrete `ready-*` checkpoint
 * in `createCheckout` (`checkout/reducer.ts`'s `NEXT_READY_BY_KIND`) and requires its
 * own `Checkout.next()` — there is no helper anywhere in this package that dispatches
 * more than one step.
 *
 * The reason is architectural, not stylistic: a design that auto-advances between
 * transactions from a watcher or effect runs into an unfixable triangle of races —
 * a wallet library's own async state-reset, UI prop staleness, and the wallet popup
 * queue — that no amount of patching fully closes; the only reliable fix is to never
 * auto-advance at all, and require an explicit user action for every single on-chain
 * step. The UX cost is one or two extra clicks; the
 * reliability gain is total. When a future atomic-execution contract ships, `steps[]`
 * collapses to one entry and nothing about this function's own signature changes —
 * that is why the shape is a list, not a fixed 2-or-3-tuple.
 *
 * Royalty is settled PER LEG, in that leg's own base currency, never consolidated
 * (`docs/NFT_SWAP_RULES.md`): the sell leg pays the sell collection's royalty in the
 * sell pool's currency, the buy leg pays the buy collection's royalty in the buy
 * pool's currency. Two collections sharing a creator wallet legitimately produce two
 * separate payments — that is fidelity to two isolated sales, not a bug.
 *
 * `missingApprovals` is checked ONLY for the sell collection (`setApprovalForAll`) —
 * the buy leg receives NFTs, it needs no approval of its own.
 */

function requireLeg(leg: QuoteLeg | undefined, label: string): QuoteLeg {
  if (!leg) throw new SnfError('UNKNOWN', `internal: the fresh re-quote returned no ${label} leg`)
  return leg
}

function requireAddress(value: `0x${string}` | undefined, label: string): `0x${string}` {
  if (value === undefined) throw new SnfError('UNKNOWN', `internal: ${label} was not resolved by the re-quote`)
  return value
}

function requireBigint(value: bigint | undefined, label: string): bigint {
  if (value === undefined) throw new SnfError('UNKNOWN', `internal: ${label} was not derived`)
  return value
}

function encodeDynamic(abi: Abi, functionName: string, args: readonly unknown[]): `0x${string}` {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
  return encodeFunctionData({ abi, functionName, args } as any)
}

export async function buildNftToNft(ctx: SnfClientContext, args: BuildArgs): Promise<ExecutionPlan> {
  const now = Math.floor(Date.now() / 1000)
  const validated = validateBuildArgs(args, now, ctx.config.defaults)
  assertParam(args.quote.side === 'nft-to-nft', 'buildNftToNft requires an nft-to-nft Quote', {
    field: 'quote.side',
  })
  const sellLegIn = args.quote.legs[0]
  const buyLegIn = args.quote.legs[1]
  assertParam(sellLegIn?.collection !== undefined, 'buildNftToNft requires a sell leg with a collection', {
    field: 'quote.legs[0].collection',
  })
  assertParam(buyLegIn?.collection !== undefined, 'buildNftToNft requires a buy leg with a collection', {
    field: 'quote.legs[1].collection',
  })
  const sellTokenIdsIn = sellLegIn?.tokenIds ?? []
  assertParam(sellTokenIdsIn.length >= 1, 'buildNftToNft requires at least one sell tokenId', {
    field: 'quote.legs[0].tokenIds',
  })
  const buyCount = buyLegIn?.count ?? 0
  assertParam(buyCount >= 1, 'buildNftToNft requires buy.count >= 1', { field: 'quote.legs[1].count' })
  assertParam(
    sellLegIn?.collection?.toLowerCase() !== buyLegIn?.collection?.toLowerCase(),
    'sell and buy collections must be different',
    { field: 'quote.legs[0].collection|quote.legs[1].collection' },
  )
  const remainderMode = args.quote.remainderMode ?? 'native'

  // ── The fresh on-chain re-quote — the ONLY source for every number below.
  const reQuote = await quoteNftToNft(ctx, {
    chainId: ctx.chain.chainId,
    sell: { collection: sellLegIn?.collection, tokenIds: sellTokenIdsIn },
    buy: { collection: buyLegIn?.collection, count: buyCount },
    remainder: remainderMode,
  })
  const sellLeg = requireLeg(reQuote.legs[0], 'sell')
  const buyLeg = requireLeg(reQuote.legs[1], 'buy')
  const sellWrapper = requireAddress(sellLeg.wrapper, 'sell wrapper')
  const buyWrapper = requireAddress(buyLeg.wrapper, 'buy wrapper')
  const sellTokenIds = sellLeg.tokenIds ?? sellTokenIdsIn
  const buyTokenIds = buyLeg.tokenIds ?? []
  const isNativeBase = sellLeg.kind === 'native'
  const baseToken = isNativeBase ? null : requireAddress(buyLeg.path[0], 'buy base token')

  const routerAbi = ctx.chain.routerVariant === 'native-erc20' ? ROUTER_NATIVE_ERC20_ABI : ROUTER02_COLLECTION_ABI

  // ── Approvals — the sell collection's setApprovalForAll ONLY (the buy leg receives
  // NFTs, it needs no approval of its own). Computed BEFORE any gas estimation
  // (Finding 2): the sell step's own swap simulation is guaranteed to
  // revert against current state while this approval is still missing — estimating
  // it live in that case would throw before the caller ever receives the very
  // approval step (below) that fixes it.
  const approvals: readonly Approval[] = await missingApprovals(ctx, {
    owner: validated.recipient,
    spender: ctx.chain.router02,
    erc721: { token: sellLeg.collection as `0x${string}` },
  })
  const sellHasPendingApproval = approvals.length > 0

  // ── Leg 1 — sell: swapExactTokensForETHCollection / …ForTokensCollection.
  const sellBounds = deriveBounds({
    side: 'sell',
    total: requireBigint(reQuote.netProceeds?.value, 'netProceeds'),
    slippageBps: validated.slippageBps,
    deadline: validated.deadline,
  })
  const sellAmountOutMin = requireBigint(sellBounds.amountOutMin, 'amountOutMin')
  const sellFunctionName = isNativeBase ? 'swapExactTokensForETHCollection' : 'swapExactTokensForTokensCollection'
  const sellTokenIdsBig = sellTokenIds.map((id) => BigInt(id))
  const sellCallArgs = [sellTokenIdsBig, sellAmountOutMin, sellLeg.path, false, validated.recipient, sellBounds.deadline] as const
  const sellData = encodeDynamic(routerAbi, sellFunctionName, sellCallArgs)
  const { gas: sellGas, gasSource: sellGasSource } = await resolveGasForStep({
    publicClient: ctx.publicClient,
    address: ctx.chain.router02,
    abi: routerAbi,
    functionName: sellFunctionName,
    args: sellCallArgs,
    account: validated.recipient,
    value: 0n,
    tokenCount: sellTokenIdsBig.length,
    hasPendingApproval: sellHasPendingApproval,
  })
  const sellStep: Step = {
    kind: 'swap-sell',
    label: '',
    tx: {
      to: ctx.chain.router02,
      data: sellData,
      value: 0n,
      chainId: ctx.chain.chainId,
      gas: sellGas,
      ...(sellGasSource ? { gasSource: sellGasSource } : {}),
    },
    approvals: [],
    bounds: sellBounds,
    quote: reQuote,
    preflightRefs: {
      payer: validated.recipient,
      collection: sellLeg.collection as `0x${string}`,
      wrapper: sellWrapper,
      pair: sellLeg.pair,
      sellTokenIds,
    },
  }

  // ── Leg 2 — buy: swapETHForExactTokensCollection / …TokensForExactTokensCollection.
  const buyBounds = deriveBounds({
    side: 'buy',
    total: requireBigint(reQuote.buyCost?.value, 'buyCost'),
    slippageBps: validated.slippageBps,
    deadline: validated.deadline,
  })
  const buyAmountInMax = requireBigint(buyBounds.amountInMax, 'amountInMax')
  const buyFunctionName = isNativeBase ? 'swapETHForExactTokensCollection' : 'swapTokensForExactTokensCollection'
  const buyTokenIdsBig = buyTokenIds.map((id) => BigInt(id))
  const buyCallArgs = isNativeBase
    ? ([buyTokenIdsBig, buyLeg.path, false, validated.recipient, buyBounds.deadline] as const)
    : ([buyTokenIdsBig, buyAmountInMax, buyLeg.path, false, validated.recipient, buyBounds.deadline] as const)
  const buyData = encodeDynamic(routerAbi, buyFunctionName, buyCallArgs)
  const buyValue = isNativeBase ? toNativeValue(ctx.chain.chainId, buyAmountInMax) : 0n
  // The buy leg needs no approval of its own (it receives NFTs) — always a live
  // estimate, unaffected by Finding 2.
  const { gas: buyGas } = await resolveGasForStep({
    publicClient: ctx.publicClient,
    address: ctx.chain.router02,
    abi: routerAbi,
    functionName: buyFunctionName,
    args: buyCallArgs,
    account: validated.recipient,
    value: buyValue,
    tokenCount: buyTokenIdsBig.length,
    hasPendingApproval: false,
  })
  const buyStep: Step = {
    kind: 'swap-buy',
    label: '',
    tx: { to: ctx.chain.router02, data: buyData, value: buyValue, chainId: ctx.chain.chainId, gas: buyGas },
    approvals: [],
    bounds: buyBounds,
    quote: reQuote,
    preflightRefs: {
      payer: validated.recipient,
      collection: buyLeg.collection as `0x${string}`,
      wrapper: buyWrapper,
      pair: buyLeg.pair,
      buyTokenIds,
      ...(baseToken === null ? {} : { erc20Base: baseToken }),
    },
  }

  const steps: Step[] = [sellStep, buyStep]

  // ── Leg 3 (optional) — the wNFT top-up: a plain fungible EXACT-INPUT swap of the
  // leftover base currency into wrapper units on the BUY collection, priced fresh by
  // quoteNftToNft itself against the buy pool's POST-buy reserves. `side: 'sell'`
  // below is deriveBounds's ROUNDING semantics (floor an amountOutMin), not this
  // leg's business role — an exact-input swap always protects its MINIMUM output.
  if (remainderMode === 'wnft') {
    const netProceeds = requireBigint(reQuote.netProceeds?.value, 'netProceeds')
    const buyCost = requireBigint(reQuote.buyCost?.value, 'buyCost')
    const remainderBaseValue = netProceeds > buyCost ? netProceeds - buyCost : 0n
    const remainderTarget = requireBigint(reQuote.remainder?.value, 'remainder')
    const wnftBounds = deriveBounds({
      side: 'sell',
      total: remainderTarget,
      slippageBps: validated.slippageBps,
      deadline: validated.deadline,
    })
    const wnftAmountOutMin = requireBigint(wnftBounds.amountOutMin, 'amountOutMin')
    const wnftPath = buildWnftRoutePath({
      wrapper: buyWrapper,
      baseToken: baseToken ?? ctx.chain.quoteToken,
      side: 'buy',
    })
    const wnftFunctionName = isNativeBase ? 'swapExactETHForTokens' : 'swapExactTokensForTokens'
    const wnftCallArgs = isNativeBase
      ? ([wnftAmountOutMin, wnftPath, validated.recipient, wnftBounds.deadline] as const)
      : ([remainderBaseValue, wnftAmountOutMin, wnftPath, validated.recipient, wnftBounds.deadline] as const)
    const wnftData = encodeDynamic(routerAbi, wnftFunctionName, wnftCallArgs)
    const wnftValue = isNativeBase ? toNativeValue(ctx.chain.chainId, remainderBaseValue) : 0n
    const { gas: wnftGas } = await resolveGasForStep({
      publicClient: ctx.publicClient,
      address: ctx.chain.router02,
      abi: routerAbi,
      functionName: wnftFunctionName,
      args: wnftCallArgs,
      account: validated.recipient,
      value: wnftValue,
      tokenCount: 0,
      hasPendingApproval: false,
    })
    steps.push({
      kind: 'swap-buy-wnft',
      label: '',
      tx: { to: ctx.chain.router02, data: wnftData, value: wnftValue, chainId: ctx.chain.chainId, gas: wnftGas },
      approvals: [],
      bounds: wnftBounds,
      quote: reQuote,
      preflightRefs: {
        payer: validated.recipient,
        collection: buyLeg.collection as `0x${string}`,
        wrapper: buyWrapper,
        pair: buyLeg.pair,
        ...(baseToken === null ? {} : { erc20Base: baseToken }),
      },
    })
  }

  // `approvals` was already computed above (before any gas estimation) — reused here
  // only to wrap it into full plan steps.
  const approvalSteps = approvals.map((a) => buildApprovalStep(a, { quote: reQuote, bounds: sellBounds }))

  return assemblePlan(ctx, [...approvalSteps, ...steps], reQuote.expiresAt)
}
