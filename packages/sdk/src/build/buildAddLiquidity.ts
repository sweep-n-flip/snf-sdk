import { assertParam, SnfError } from '../errors'
import { quoteAddLiquidity } from '../liquidity/quoteAddLiquidity'
import { buildApprovalStep } from './approvals'
import { depositApprovals, depositBounds, buildDepositStep } from './liquidityDeposit'
import { assemblePlan } from './plan'
import { assertAddress, validateBuildArgs } from './validate'
import type { SnfClientContext } from '../types/client.types'
import type { BuildAddLiquidityArgs } from '../types/liquidity.types'
import type { ExecutionPlan, Step } from '../types/plan.types'

/**
 * `buildAddLiquidity` — an unsigned deposit `ExecutionPlan` into an EXISTING pool.
 * Same discipline as every other builder in this package: `args.quote` is read only
 * for identity (collection, tokenIds, base), and every number that ends up in
 * `bounds`/`tx` comes from a FRESH `quoteAddLiquidity` call this function performs
 * itself.
 */

function requireAddress(value: `0x${string}` | undefined, label: string): `0x${string}` {
  if (value === undefined) throw new SnfError('UNKNOWN', `internal: ${label} was not resolved by the re-quote`)
  return value
}

function requireBigint(value: bigint | undefined, label: string): bigint {
  if (value === undefined) throw new SnfError('UNKNOWN', `internal: ${label} was not derived by the re-quote`)
  return value
}

export async function buildAddLiquidity(ctx: SnfClientContext, args: BuildAddLiquidityArgs): Promise<ExecutionPlan> {
  const now = Math.floor(Date.now() / 1000)
  const validated = validateBuildArgs(args, now, ctx.config.defaults)
  assertParam(args.quote.side === 'add-liquidity', 'buildAddLiquidity requires an add-liquidity Quote', {
    field: 'quote.side',
  })
  const collection = requireAddress(args.quote.collection, 'quote.collection')
  const lpRecipient = args.lpRecipient !== undefined ? assertAddress(args.lpRecipient, 'lpRecipient') : validated.recipient
  assertParam(validated.tokenIds.length >= 1, 'buildAddLiquidity requires at least one tokenId', {
    field: 'quote.tokenIds',
  })

  const originalLiquidity = args.quote.liquidity
  assertParam(originalLiquidity !== undefined, 'buildAddLiquidity requires a Quote with a liquidity sub-object', {
    field: 'quote.liquidity',
  })
  const isNative = originalLiquidity.baseToken.isNative
  const baseToken = isNative ? undefined : requireAddress(originalLiquidity.baseToken.address ?? undefined, 'quote.liquidity.baseToken.address')

  const reQuote = await quoteAddLiquidity(ctx, {
    chainId: ctx.chain.chainId,
    collection,
    tokenIds: validated.tokenIds,
    ...(baseToken !== undefined ? { baseToken } : {}),
  })
  const liquidity = reQuote.liquidity
  assertParam(liquidity !== undefined, 'internal: the fresh re-quote returned no liquidity sub-object', {
    field: 'quote.liquidity',
  })

  const required = requireBigint(liquidity.baseRequired?.value, 'liquidity.baseRequired')
  const ceilDesired = isNative ? undefined : requireBigint(liquidity.baseDesired?.value, 'liquidity.baseDesired')
  const bounds = depositBounds({
    mode: 'slippage',
    isNative,
    required,
    ...(ceilDesired !== undefined ? { ceilDesired } : {}),
    slippageBps: validated.slippageBps,
  })

  const approvals = await depositApprovals(ctx, {
    owner: validated.recipient,
    spender: ctx.chain.router02,
    collection,
    ...(baseToken !== undefined ? { erc20Base: { token: baseToken, amount: bounds.desired } } : {}),
  })

  const depositStep = await buildDepositStep(ctx, {
    quote: reQuote,
    collection,
    wrapper: liquidity.wrapper,
    pair: liquidity.pair,
    isNative,
    ...(baseToken !== undefined ? { baseToken } : {}),
    tokenIds: validated.tokenIds,
    nftCount: validated.tokenIds.length,
    desired: bounds.desired,
    min: bounds.min,
    to: lpRecipient,
    payer: validated.recipient,
    deadline: validated.deadline,
    slippageBps: validated.slippageBps,
    hasPendingApproval: approvals.length > 0,
  })

  const steps: Step[] = approvals.map((a) => buildApprovalStep(a, { quote: reQuote, bounds: depositStep.bounds }))
  steps.push(depositStep)

  return assemblePlan(ctx, steps, reQuote.expiresAt)
}
