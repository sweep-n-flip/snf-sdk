import { encodeFunctionData } from 'viem'
import type { Abi } from 'viem'

import { ROUTER02_COLLECTION_ABI } from '../abis/UniswapV2Router02Collection'
import { ROUTER_NATIVE_ERC20_ABI } from '../abis/UniswapV2Router01CollectionNativeERC20'
import { assertParam, SnfError } from '../errors'
import { quoteSell } from '../quote/quoteSell'
import { buildApprovalStep, missingApprovals } from './approvals'
import { deriveBounds } from './bounds'
import { resolveGasForStep } from './gas'
import { assemblePlan } from './plan'
import { validateBuildArgs } from './validate'
import type { SnfClientContext } from '../types/client.types'
import type { Approval, BuildArgs, ExecutionPlan, Step } from '../types/plan.types'
import type { QuoteLeg } from '../types/quote.types'

/**
 * `buildSell` — an unsigned sell `ExecutionPlan` (R13) — same discipline as
 * `buildBuy`: every number in `tx.data`/`bounds` comes from a FRESH `quoteSell` call
 * this function performs itself, `args.quote` is read only for identity. A sell
 * ALWAYS needs `setApprovalForAll(router, true)` on the sell collection (the caller's
 * NFTs move INTO the Router) — regardless of which base token the pool pays out in —
 * and NEVER needs an ERC-20 allowance (the caller receives the base token, never
 * spends one). `tx.value` is always `0n`.
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

/** The base token being received, read from the CALLER's quote leg — identity only.
 * `path[1]` is the sell-side convention `buildNftRoutePath` uses: `[collection,
 * baseToken]`. `null` means native. */
function receiveTokenFromLeg(leg: QuoteLeg | undefined): `0x${string}` | null {
  if (!leg || leg.kind === 'native') return null
  return leg.path[1] ?? null
}

/**
 * `encodeFunctionData` with a DYNAMICALLY-CHOSEN function name — viem's own overload
 * resolution cannot narrow a runtime `string` to one specific ABI function signature,
 * the identical class of problem `build/gas.ts`'s `estimateGasWithBuffer` documents.
 */
function encodeDynamic(abi: Abi, functionName: string, args: readonly unknown[]): `0x${string}` {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
  return encodeFunctionData({ abi, functionName, args } as any)
}

export async function buildSell(ctx: SnfClientContext, args: BuildArgs): Promise<ExecutionPlan> {
  const now = Math.floor(Date.now() / 1000)
  const validated = validateBuildArgs(args, now)
  assertParam(args.quote.side === 'sell', 'buildSell requires a sell Quote', { field: 'quote.side' })
  assertParam(args.quote.collection !== undefined, 'buildSell requires a Quote with a collection', {
    field: 'quote.collection',
  })
  assertParam(validated.tokenIds.length >= 1, 'buildSell requires at least one tokenId', { field: 'quote.tokenIds' })

  const receiveToken = receiveTokenFromLeg(args.quote.legs[0])
  const reQuote = await quoteSell(ctx, {
    chainId: ctx.chain.chainId,
    collection: args.quote.collection,
    tokenIds: validated.tokenIds,
    receiveToken,
  })
  const leg = requireLeg(reQuote.legs[0], 'sell')
  const wrapper = requireAddress(leg.wrapper, 'wrapper')
  const tokenIds = leg.tokenIds ?? validated.tokenIds
  const isNative = receiveToken === null

  const bounds = deriveBounds({
    side: 'sell',
    total: requireBigint(reQuote.totalProceeds?.value, 'totalProceeds'),
    slippageBps: validated.slippageBps,
    deadline: validated.deadline,
  })
  const amountOutMin = requireBigint(bounds.amountOutMin, 'amountOutMin')

  const routerAbi = ctx.chain.routerVariant === 'native-erc20' ? ROUTER_NATIVE_ERC20_ABI : ROUTER02_COLLECTION_ABI
  const functionName = isNative ? 'swapExactTokensForETHCollection' : 'swapExactTokensForTokensCollection'
  const tokenIdsBig = tokenIds.map((id) => BigInt(id))
  // capRoyaltyFee is the literal `false` — SPEC prohibition #6.
  const callArgs = [tokenIdsBig, amountOutMin, leg.path, false, validated.recipient, bounds.deadline] as const
  const data = encodeDynamic(routerAbi, functionName, callArgs)

  const approvals: readonly Approval[] = await missingApprovals(ctx, {
    owner: validated.recipient,
    spender: ctx.chain.router02,
    erc721: { token: reQuote.collection as `0x${string}` },
  })

  // `hasPendingApproval`: this step's own swap simulation is guaranteed to revert
  // against current state while the `setApprovalForAll` above is still missing —
  // skip the live estimate entirely rather than throwing before the caller ever
  // receives this very approval step (Finding 2, snf-54-18F).
  const { gas, gasSource } = await resolveGasForStep({
    publicClient: ctx.publicClient,
    address: ctx.chain.router02,
    abi: routerAbi,
    functionName,
    args: callArgs,
    account: validated.recipient,
    value: 0n,
    tokenCount: tokenIdsBig.length,
    hasPendingApproval: approvals.length > 0,
  })

  const swapStep: Step = {
    kind: 'swap-sell',
    label: '',
    tx: { to: ctx.chain.router02, data, value: 0n, chainId: ctx.chain.chainId, gas, ...(gasSource ? { gasSource } : {}) },
    approvals: [],
    bounds,
    quote: reQuote,
    preflightRefs: {
      payer: validated.recipient,
      collection: reQuote.collection as `0x${string}`,
      wrapper,
      pair: leg.pair,
      sellTokenIds: tokenIds,
    },
  }

  const steps: Step[] = approvals.map((a) => buildApprovalStep(a, { quote: reQuote, bounds }))
  steps.push(swapStep)

  return assemblePlan(ctx, steps, reQuote.expiresAt)
}
