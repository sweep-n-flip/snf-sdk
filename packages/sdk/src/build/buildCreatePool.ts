import { assertParam, SnfError } from '../errors'
import { quoteCreatePool } from '../liquidity/quoteCreatePool'
import { buildApprovalStep } from './approvals'
import { depositApprovals, depositBounds, buildDepositStep } from './liquidityDeposit'
import { assemblePlan } from './plan'
import { assertAddress, resolveDeadline } from './validate'
import type { SnfClientContext } from '../types/client.types'
import type { BuildCreatePoolArgs } from '../types/liquidity.types'
import type { ExecutionPlan, Step } from '../types/plan.types'

/**
 * `buildCreatePool` — an unsigned pool-creating deposit `ExecutionPlan`, with EXACT
 * minimums (min = the intended amount, never zero or loosened). `args.quote` is read
 * only for identity — collection, tokenIds, base, and the caller's OWN chosen
 * `baseAmount` (the initial price is the partner's decision, never a market figure
 * read back from anywhere) — every other number comes from a FRESH `quoteCreatePool`
 * call this function performs itself, which also re-confirms the pool is STILL
 * liquidity-free (a pair that gained reserves between quote and build throws
 * `INVALID_PARAMS` instead of ever producing a plan).
 */

function requireAddress(value: `0x${string}` | undefined, label: string): `0x${string}` {
  if (value === undefined) throw new SnfError('UNKNOWN', `internal: ${label} was not resolved by the re-quote`)
  return value
}

function requireBigint(value: bigint | undefined, label: string): bigint {
  if (value === undefined) throw new SnfError('UNKNOWN', `internal: ${label} was not derived`)
  return value
}

export async function buildCreatePool(ctx: SnfClientContext, args: BuildCreatePoolArgs): Promise<ExecutionPlan> {
  const now = Math.floor(Date.now() / 1000)
  const recipient = assertAddress(args.recipient, 'recipient')
  const lpRecipient = args.lpRecipient !== undefined ? assertAddress(args.lpRecipient, 'lpRecipient') : recipient
  const deadline = resolveDeadline(args.deadline, now, ctx.config.defaults)

  assertParam(args.quote.side === 'create-pool', 'buildCreatePool requires a create-pool Quote', {
    field: 'quote.side',
  })
  const collection = requireAddress(args.quote.collection, 'quote.collection')
  const tokenIds = args.quote.tokenIds ?? []

  const originalLiquidity = args.quote.liquidity
  assertParam(originalLiquidity !== undefined, 'buildCreatePool requires a Quote with a liquidity sub-object', {
    field: 'quote.liquidity',
  })
  const isNative = originalLiquidity.baseToken.isNative
  const baseToken = isNative ? undefined : requireAddress(originalLiquidity.baseToken.address ?? undefined, 'quote.liquidity.baseToken.address')
  // The caller's own declared opening price — identity, never a Router-derived
  // figure (there is nothing on-chain to re-derive it from: the caller IS the
  // price's authority for a pool that does not yet have one).
  const baseAmount = requireBigint(originalLiquidity.baseRequired?.value, 'quote.liquidity.baseRequired')

  const reQuote = await quoteCreatePool(ctx, {
    chainId: ctx.chain.chainId,
    collection,
    tokenIds,
    baseAmount,
    ...(baseToken !== undefined ? { baseToken } : {}),
  })
  const liquidity = reQuote.liquidity
  assertParam(liquidity !== undefined, 'internal: the fresh re-quote returned no liquidity sub-object', {
    field: 'quote.liquidity',
  })

  // Exact mode: min = desired = baseAmount on both bases — the front-run guard this
  // whole builder exists to enforce.
  const bounds = depositBounds({ mode: 'exact', isNative, required: baseAmount, ceilDesired: baseAmount })

  const approvals = await depositApprovals(ctx, {
    owner: recipient,
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
    tokenIds,
    nftCount: tokenIds.length,
    desired: bounds.desired,
    min: bounds.min,
    to: lpRecipient,
    payer: recipient,
    deadline,
    slippageBps: 0,
    hasPendingApproval: approvals.length > 0,
  })

  const steps: Step[] = approvals.map((a) => buildApprovalStep(a, { quote: reQuote, bounds: depositStep.bounds }))
  steps.push(depositStep)

  return assemblePlan(ctx, steps, reQuote.expiresAt)
}
