import { encodeFunctionData } from 'viem'
import type { Abi } from 'viem'

import { ROUTER02_COLLECTION_ABI } from '../abis/UniswapV2Router02Collection'
import { ROUTER_NATIVE_ERC20_ABI } from '../abis/UniswapV2Router01CollectionNativeERC20'
import { toNativeValue } from '../chains/units'
import { assertParam, SnfError } from '../errors'
import { quoteBuy } from '../quote/quoteBuy'
import { buildApprovalStep, missingApprovals } from './approvals'
import { deriveBounds } from './bounds'
import { estimateGasWithBuffer } from './gas'
import { assemblePlan } from './plan'
import { validateBuildArgs } from './validate'
import type { SnfClientContext } from '../types/client.types'
import type { Approval, BuildArgs, ExecutionPlan, Step } from '../types/plan.types'
import type { QuoteLeg } from '../types/quote.types'

/**
 * `buildBuy` — an unsigned buy `ExecutionPlan` (R13). Every number in `tx.data`/
 * `tx.value`/`bounds` comes from a FRESH `quoteBuy` call this function performs
 * itself — `args.quote` is read only for IDENTITY (`collection`, `tokenIds`, which
 * pool/base token was quoted), never for its priced fields (`totalCost`, `fees`). A
 * caller who doubles `args.quote.totalCost.value` before calling gets byte-identical
 * `bounds`/`tx` back (SPEC prohibition #2 — `test/build/buildBuy.test.ts`'s
 * tampered-quote case is the proof). `capRoyaltyFee` is the literal `false` at the one
 * encode call below, matching every other `*Collection` call site in this package.
 *
 * Native buy needs NO approval at all (ETH moves via `tx.value`, no NFTs come FROM
 * the caller — `UniswapV2Router02Collection.ts`'s own doc comment says as much). An
 * ERC-20-base buy needs exactly one `erc20-allowance` approval when the allowance is
 * insufficient; never an `erc721-approval-for-all` (the caller owns no NFTs yet).
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

/** The base token being spent, read from the CALLER's quote leg — identity only,
 * never a price (see module header). `null` means native. `path[0]` is the buy-side
 * convention `buildNftRoutePath` uses: `[baseToken, collection]`. */
function payTokenFromLeg(leg: QuoteLeg | undefined): `0x${string}` | null {
  if (!leg || leg.kind === 'native') return null
  return leg.path[0] ?? null
}

/**
 * `encodeFunctionData` with a DYNAMICALLY-CHOSEN function name (native vs. ERC-20
 * entry point) — viem's own overload resolution cannot narrow a runtime `string` to
 * one specific ABI function signature, the identical class of problem `build/gas.ts`'s
 * `estimateGasWithBuffer` already documents and casts around.
 */
function encodeDynamic(abi: Abi, functionName: string, args: readonly unknown[]): `0x${string}` {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
  return encodeFunctionData({ abi, functionName, args } as any)
}

export async function buildBuy(ctx: SnfClientContext, args: BuildArgs): Promise<ExecutionPlan> {
  const now = Math.floor(Date.now() / 1000)
  const validated = validateBuildArgs(args, now)
  assertParam(args.quote.side === 'buy', 'buildBuy requires a buy Quote', { field: 'quote.side' })
  assertParam(args.quote.collection !== undefined, 'buildBuy requires a Quote with a collection', {
    field: 'quote.collection',
  })
  assertParam(validated.tokenIds.length >= 1, 'buildBuy requires at least one tokenId', { field: 'quote.tokenIds' })

  // ── The fresh on-chain re-quote — the ONLY source for every number below. The
  // payToken is read from the CALLER's quote for identity only (which pool/base was
  // quoted), never its price.
  const payToken = payTokenFromLeg(args.quote.legs[0])
  const reQuote = await quoteBuy(ctx, {
    chainId: ctx.chain.chainId,
    collection: args.quote.collection,
    tokenIds: validated.tokenIds,
    payToken,
  })
  const leg = requireLeg(reQuote.legs[0], 'buy')
  const wrapper = requireAddress(leg.wrapper, 'wrapper')
  const tokenIds = leg.tokenIds ?? validated.tokenIds
  const isNative = payToken === null

  const bounds = deriveBounds({
    side: 'buy',
    total: requireBigint(reQuote.totalCost?.value, 'totalCost'),
    slippageBps: validated.slippageBps,
    deadline: validated.deadline,
  })
  const amountInMax = requireBigint(bounds.amountInMax, 'amountInMax')

  const routerAbi = ctx.chain.routerVariant === 'native-erc20' ? ROUTER_NATIVE_ERC20_ABI : ROUTER02_COLLECTION_ABI
  const functionName = isNative ? 'swapETHForExactTokensCollection' : 'swapTokensForExactTokensCollection'
  const tokenIdsBig = tokenIds.map((id) => BigInt(id))
  // capRoyaltyFee is the literal `false` — SPEC prohibition #6.
  const callArgs = isNative
    ? ([tokenIdsBig, leg.path, false, validated.recipient, bounds.deadline] as const)
    : ([tokenIdsBig, amountInMax, leg.path, false, validated.recipient, bounds.deadline] as const)
  const data = encodeDynamic(routerAbi, functionName, callArgs)
  const value = isNative ? toNativeValue(ctx.chain.chainId, amountInMax) : 0n

  const approvals: readonly Approval[] = await missingApprovals(ctx, {
    owner: validated.recipient,
    spender: ctx.chain.router02,
    ...(isNative ? {} : { erc20: { token: requireAddress(payToken ?? undefined, 'payToken'), amount: amountInMax } }),
  })

  const gas = await estimateGasWithBuffer({
    publicClient: ctx.publicClient,
    address: ctx.chain.router02,
    abi: routerAbi,
    functionName,
    args: callArgs,
    account: validated.recipient,
    value,
    tokenCount: tokenIdsBig.length,
  })

  const swapStep: Step = {
    kind: 'swap-buy',
    label: '',
    tx: { to: ctx.chain.router02, data, value, chainId: ctx.chain.chainId, gas },
    approvals: [],
    bounds,
    quote: reQuote,
    preflightRefs: {
      payer: validated.recipient,
      collection: reQuote.collection as `0x${string}`,
      wrapper,
      pair: leg.pair,
      buyTokenIds: tokenIds,
      ...(isNative ? {} : { erc20Base: requireAddress(payToken ?? undefined, 'payToken') }),
    },
  }

  const steps: Step[] = approvals.map((a) => buildApprovalStep(a, { quote: reQuote, bounds }))
  steps.push(swapStep)

  return assemblePlan(ctx, steps, reQuote.expiresAt)
}
