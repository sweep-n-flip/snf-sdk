import { encodeFunctionData } from 'viem'
import type { Abi } from 'viem'

import { ROUTER02_COLLECTION_ABI } from '../abis/UniswapV2Router02Collection'
import { ROUTER_NATIVE_ERC20_ABI } from '../abis/UniswapV2Router01CollectionNativeERC20'
import { toNativeValue } from '../chains/units'
import { assertParam, SnfError } from '../errors'
import { quoteSwap } from '../quote/quoteSwap'
import { buildApprovalStep, missingApprovals } from './approvals'
import { deriveBounds } from './bounds'
import { resolveGasForStep } from './gas'
import { assemblePlan } from './plan'
import { validateBuildArgs } from './validate'
import type { SnfClientContext } from '../types/client.types'
import type { Approval, BuildArgs, ExecutionPlan, Step } from '../types/plan.types'

/**
 * `buildSwap` — the fungible↔fungible builder. Same discipline as the NFT
 * builders: every number in `tx.data`/`bounds` comes from a FRESH `quoteSwap` call
 * this function performs itself. `args.quote` is read only for IDENTITY — which
 * tokens (`legs[0].path`) and which side the caller pinned exactly
 * (`amountSpecified`, this module's own `Quote` addition) — never for the price the
 * OTHER side quoted.
 */

function requireBigint(value: bigint | undefined, label: string): bigint {
  if (value === undefined) throw new SnfError('UNKNOWN', `internal: ${label} was not derived`)
  return value
}

function encodeDynamic(abi: Abi, functionName: string, args: readonly unknown[]): `0x${string}` {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
  return encodeFunctionData({ abi, functionName, args } as any)
}

/**
 * The six-entry Router-function table this file encodes against, reviewable at a
 * glance rather than buried in nested ternaries:
 *
 * | exactSide | isNativeIn | isNativeOut | function |
 * |-----------|------------|-------------|----------------------------|
 * | 'in' | true | — | swapExactETHForTokens |
 * | 'in' | false | true | swapExactTokensForETH |
 * | 'in' | false | false | swapExactTokensForTokens |
 * | 'out' | true | — | swapETHForExactTokens |
 * | 'out' | false | true | swapTokensForExactETH |
 * | 'out' | false | false | swapTokensForExactTokens |
 */
export function selectFungibleEntryPoint(args: {
  readonly isNativeIn: boolean
  readonly isNativeOut: boolean
  readonly exactSide: 'in' | 'out'
}): string {
  if (args.exactSide === 'in') {
    if (args.isNativeIn) return 'swapExactETHForTokens'
    if (args.isNativeOut) return 'swapExactTokensForETH'
    return 'swapExactTokensForTokens'
  }
  if (args.isNativeIn) return 'swapETHForExactTokens'
  if (args.isNativeOut) return 'swapTokensForExactETH'
  return 'swapTokensForExactTokens'
}

export async function buildSwap(ctx: SnfClientContext, args: BuildArgs): Promise<ExecutionPlan> {
  const now = Math.floor(Date.now() / 1000)
  const validated = validateBuildArgs(args, now)
  assertParam(args.quote.side === 'swap', 'buildSwap requires a swap Quote', { field: 'quote.side' })
  const leg = args.quote.legs[0]
  const path = leg?.path ?? []
  assertParam(path.length >= 2, 'buildSwap requires a Quote leg with a resolved path', {
    field: 'quote.legs[0].path',
  })
  const inAddr = path[0]
  const outAddr = path[path.length - 1]
  assertParam(inAddr !== undefined, 'buildSwap requires a Quote leg with a resolved path', {
    field: 'quote.legs[0].path',
  })
  assertParam(outAddr !== undefined, 'buildSwap requires a Quote leg with a resolved path', {
    field: 'quote.legs[0].path',
  })
  const quoteTokenLower = ctx.chain.quoteToken.toLowerCase()
  const isNativeIn = inAddr.toLowerCase() === quoteTokenLower
  const isNativeOut = outAddr.toLowerCase() === quoteTokenLower
  const exactSide = args.quote.amountSpecified ?? 'in'

  // ── The fresh on-chain re-quote — the ONLY source for every number below. The
  // SPECIFIED side (`amountIn` or `amountOut`) is read from the caller's quote for
  // IDENTITY (the trade size the user chose), never the other, derived side.
  const reQuote = await quoteSwap(ctx, {
    chainId: ctx.chain.chainId,
    tokenIn: isNativeIn ? null : inAddr,
    tokenOut: isNativeOut ? null : outAddr,
    ...(exactSide === 'in'
      ? { amountIn: requireBigint(args.quote.amountIn?.value, 'amountIn') }
      : { amountOut: requireBigint(args.quote.amountOut?.value, 'amountOut') }),
  })
  const reLeg = reQuote.legs[0]
  if (!reLeg) throw new SnfError('UNKNOWN', 'internal: the fresh re-quote returned no leg')
  const rePath = reLeg.path

  const boundsSide = exactSide === 'in' ? 'sell' : 'buy'
  const boundsTotal =
    exactSide === 'in' ? requireBigint(reQuote.amountOut?.value, 'amountOut') : requireBigint(reQuote.amountIn?.value, 'amountIn')
  const bounds = deriveBounds({ side: boundsSide, total: boundsTotal, slippageBps: validated.slippageBps, deadline: validated.deadline })

  const functionName = selectFungibleEntryPoint({ isNativeIn, isNativeOut, exactSide })
  const routerAbi = ctx.chain.routerVariant === 'native-erc20' ? ROUTER_NATIVE_ERC20_ABI : ROUTER02_COLLECTION_ABI

  let callArgs: readonly unknown[]
  let value: bigint
  let erc20SpendAmount: bigint | undefined
  if (exactSide === 'in') {
    const amountIn = requireBigint(reQuote.amountIn?.value, 'amountIn')
    const amountOutMin = requireBigint(bounds.amountOutMin, 'amountOutMin')
    callArgs = isNativeIn
      ? [amountOutMin, rePath, validated.recipient, bounds.deadline]
      : [amountIn, amountOutMin, rePath, validated.recipient, bounds.deadline]
    value = isNativeIn ? toNativeValue(ctx.chain.chainId, amountIn) : 0n
    erc20SpendAmount = isNativeIn ? undefined : amountIn
  } else {
    const amountOut = requireBigint(reQuote.amountOut?.value, 'amountOut')
    const amountInMax = requireBigint(bounds.amountInMax, 'amountInMax')
    callArgs = isNativeIn
      ? [amountOut, rePath, validated.recipient, bounds.deadline]
      : [amountOut, amountInMax, rePath, validated.recipient, bounds.deadline]
    value = isNativeIn ? toNativeValue(ctx.chain.chainId, amountInMax) : 0n
    erc20SpendAmount = isNativeIn ? undefined : amountInMax
  }
  const data = encodeDynamic(routerAbi, functionName, callArgs)

  const approvals: readonly Approval[] = await missingApprovals(ctx, {
    owner: validated.recipient,
    spender: ctx.chain.router02,
    ...(erc20SpendAmount === undefined ? {} : { erc20: { token: inAddr, amount: erc20SpendAmount } }),
  })

  // `hasPendingApproval`: this step's own swap simulation is guaranteed to revert
  // against current state while the ERC-20 allowance above is still missing — skip
  // the live estimate entirely rather than throwing before the caller ever receives
  // this very approval step (Finding 2, — the finding's own primary
  // example, first traced on this function).
  const { gas, gasSource } = await resolveGasForStep({
    publicClient: ctx.publicClient,
    address: ctx.chain.router02,
    abi: routerAbi,
    functionName,
    args: callArgs,
    account: validated.recipient,
    value,
    tokenCount: 0,
    hasPendingApproval: approvals.length > 0,
  })

  // No `preflightRefs` — a fungible swap has no NFT collection/wrapper/pair to
  // verify ownership against. `runPreflight`'s native-balance check (which sums
  // `tx.value` across EVERY step regardless of `preflightRefs`) still covers a
  // native-in swap; an ERC-20-in swap's balance is checked at BUILD time by
  // `missingApprovals` above, not re-verified at `preflight()` time — a documented
  // scope boundary, not an oversight (see this plan's SUMMARY).
  const swapStep: Step = {
    kind: 'swap-fungible',
    label: '',
    tx: { to: ctx.chain.router02, data, value, chainId: ctx.chain.chainId, gas, ...(gasSource ? { gasSource } : {}) },
    approvals: [],
    bounds,
    quote: reQuote,
  }

  const steps: Step[] = approvals.map((a) => buildApprovalStep(a, { quote: reQuote, bounds }))
  steps.push(swapStep)

  return assemblePlan(ctx, steps, reQuote.expiresAt)
}
