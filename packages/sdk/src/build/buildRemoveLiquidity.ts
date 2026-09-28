import { ROUTER02_COLLECTION_ABI } from '../abis/UniswapV2Router02Collection'
import { ROUTER_NATIVE_ERC20_ABI } from '../abis/UniswapV2Router01CollectionNativeERC20'
import { attributionSuffixFor } from '../attribution/sdkSuffix'
import { assertParam, isSnfError, SnfError } from '../errors'
import { ONE_WNFT } from '../liquidity/liquidityMath'
import { quoteRemoveLiquidity } from '../liquidity/quoteRemoveLiquidity'
import { reconcileExact } from '../math/reconcile'
import { buildApprovalStep, missingApprovals } from './approvals'
import { applySlippageDown } from './bounds'
import { encodeDynamic, simulateDynamic } from './dynamicCall'
import { resolveGasForStep } from './gas'
import { assemblePlan } from './plan'
import { validateBuildArgs } from './validate'
import type { SnfClientContext } from '../types/client.types'
import type { Approval, Bounds, BuildArgs, ExecutionPlan, Step } from '../types/plan.types'
import type { Quote } from '../types/quote.types'

/**
 * `buildRemoveLiquidity` — an unsigned withdrawal `ExecutionPlan` from an EXISTING
 * pair, in either mode. Same discipline as every other builder in this package:
 * `args.quote` is read only for identity (pair, mode, the LP amount the caller chose
 * to burn, and — `nft` mode — the ids), and every number that ends up in
 * `bounds`/`tx` comes from a FRESH `quoteRemoveLiquidity` call this function performs
 * itself. The LP being withdrawn is approved to `router02` with a plain
 * `Pair.approve` — no permit variant exists for the collection-aware remove path,
 * and this package never encodes one.
 */

function requireBigint(value: bigint | undefined, label: string): bigint {
  if (value === undefined) throw new SnfError('UNKNOWN', `internal: ${label} was not derived by the re-quote`)
  return value
}

function requireAddress(value: `0x${string}` | null | undefined, label: string): `0x${string}` {
  if (value === null || value === undefined) {
    throw new SnfError('UNKNOWN', `internal: ${label} was not resolved by the re-quote`)
  }
  return value
}

function requireNumber(value: number | undefined, label: string): number {
  if (value === undefined) throw new SnfError('UNKNOWN', `internal: ${label} was not derived by the re-quote`)
  return value
}

/** Returns the SAME `Quote`, with one more entry appended to its (possibly absent)
 * `warnings` array — never mutates the original (mirrors `liquidityDeposit.ts`'s own
 * private helper of the same name). */
function withWarning(quote: Quote, warning: string): Quote {
  return { ...quote, warnings: [...(quote.warnings ?? []), warning] }
}

export async function buildRemoveLiquidity(ctx: SnfClientContext, args: BuildArgs): Promise<ExecutionPlan> {
  const now = Math.floor(Date.now() / 1000)
  const validated = validateBuildArgs(args, now, ctx.config.defaults)
  assertParam(args.quote.side === 'remove-liquidity', 'buildRemoveLiquidity requires a remove-liquidity Quote', {
    field: 'quote.side',
  })

  const originalLiquidity = args.quote.liquidity
  assertParam(originalLiquidity !== undefined, 'buildRemoveLiquidity requires a Quote with a liquidity sub-object', {
    field: 'quote.liquidity',
  })

  const owner = requireAddress(originalLiquidity.owner, 'quote.liquidity.owner')
  assertParam(validated.recipient.toLowerCase() === owner.toLowerCase(), 'recipient must equal the LP owner named by the quote — only the owner can sign this withdrawal', {
    field: 'recipient',
  })

  const pair = requireAddress(originalLiquidity.pair, 'quote.liquidity.pair')
  const mode = originalLiquidity.mode
  assertParam(mode !== undefined, 'internal: a remove-liquidity Quote requires liquidity.mode', {
    field: 'quote.liquidity.mode',
  })
  const lpIn = requireBigint(originalLiquidity.lpIn?.value, 'quote.liquidity.lpIn')
  const originalTokenIds = args.quote.tokenIds ?? []

  // Identity-only re-quote: pair, owner, mode, the exact LP amount the caller
  // already chose to burn (a user choice, not a price — never re-derived from a
  // bps here), and — nft mode — the exact ids the caller's own quote resolved.
  let reQuote: Quote
  try {
    reQuote = await quoteRemoveLiquidity(ctx, {
      chainId: ctx.chain.chainId,
      pair,
      owner,
      liquidity: lpIn,
      mode,
      ...(mode === 'nft' ? { tokenIds: originalTokenIds } : {}),
    })
  } catch (e) {
    // The live whole-NFT count moved since the caller's own quote was taken — the
    // price moved, not the caller's parameters; re-quote instead of a bare
    // INVALID_PARAMS the caller cannot act on other than starting over.
    if (isSnfError(e) && e.code === 'INVALID_PARAMS' && e.details?.reason === 'count-mismatch') {
      throw new SnfError(
        'INSUFFICIENT_OUTPUT_AMOUNT',
        'The whole-NFT count this withdrawal would produce has changed since it was quoted — re-quote.',
        { details: { reason: 'nft-count-changed' }, cause: e },
      )
    }
    throw e
  }

  const liquidity = reQuote.liquidity
  assertParam(liquidity !== undefined, 'internal: the fresh re-quote returned no liquidity sub-object', {
    field: 'quote.liquidity',
  })

  const isNative = liquidity.baseToken.isNative
  const baseTokenAddr = isNative ? undefined : requireAddress(liquidity.baseToken.address, 'quote.liquidity.baseToken.address')
  const wrapper = requireAddress(liquidity.wrapper, 'quote.liquidity.wrapper')
  const collection = requireAddress(reQuote.collection, 'quote.collection')

  const baseOut = requireBigint(liquidity.baseOut?.value, 'liquidity.baseOut')
  const wnftOut = requireBigint(liquidity.wnftOut?.value, 'liquidity.wnftOut')
  const nftWhole = mode === 'nft' ? requireNumber(liquidity.nftWhole, 'liquidity.nftWhole') : undefined
  const wnftRemainder = mode === 'nft' ? requireBigint(liquidity.wnftRemainder?.value, 'liquidity.wnftRemainder') : undefined
  const tokenIds = mode === 'nft' ? (reQuote.tokenIds ?? []) : []
  const tokenIdsBig = tokenIds.map((id) => BigInt(id))

  const amountOutMin = applySlippageDown(baseOut, validated.slippageBps)
  const wnftOutMin = mode === 'nft' ? BigInt(tokenIdsBig.length) * ONE_WNFT : applySlippageDown(wnftOut, validated.slippageBps)
  const bounds: Bounds = { amountOutMin, wnftOutMin, slippageBps: validated.slippageBps, deadline: validated.deadline }

  const approvals: readonly Approval[] = await missingApprovals(ctx, {
    owner: validated.recipient,
    spender: ctx.chain.router02,
    lp: { token: pair, amount: lpIn },
  })
  const hasPendingApproval = approvals.length > 0

  const routerAbi = ctx.chain.routerVariant === 'native-erc20' ? ROUTER_NATIVE_ERC20_ABI : ROUTER02_COLLECTION_ABI
  let functionName: string
  let callArgs: readonly unknown[]
  if (mode === 'nft') {
    if (isNative) {
      functionName = 'removeLiquidityETHCollection'
      callArgs = [collection, lpIn, tokenIdsBig, amountOutMin, validated.recipient, bounds.deadline] as const
    } else {
      functionName = 'removeLiquidityCollection'
      callArgs = [baseTokenAddr, collection, lpIn, tokenIdsBig, amountOutMin, validated.recipient, bounds.deadline] as const
    }
  } else {
    if (isNative) {
      functionName = 'removeLiquidityETH'
      callArgs = [wrapper, lpIn, wnftOutMin, amountOutMin, validated.recipient, bounds.deadline] as const
    } else {
      functionName = 'removeLiquidity'
      callArgs = [baseTokenAddr, wrapper, lpIn, amountOutMin, wnftOutMin, validated.recipient, bounds.deadline] as const
    }
  }
  const data = encodeDynamic(routerAbi, functionName, callArgs)

  let stepQuote = reQuote
  if (!hasPendingApproval) {
    const blockNumber = requireBigint(liquidity.blockNumber, 'liquidity.blockNumber')
    const result = await simulateDynamic(ctx.publicClient, {
      address: ctx.chain.router02,
      abi: routerAbi,
      functionName,
      args: callArgs,
      account: validated.recipient,
      value: 0n,
      blockNumber,
    })
    const [slotA, slotB] = result as readonly [bigint, bigint]
    // Native functions return (wnft-side, base-side); ERC-20 functions return
    // (base-side, wnft-side) — see this function's own encoding above (the native
    // "token" side is always the wnft leg, the "ETH" side is always the base leg;
    // the ERC-20 functions name tokenA=base first, tokenB=wrapper second). The
    // wnft-side reading is the REMAINDER in nft mode (the whole ids are redeemed
    // separately by the wrapper's own burn) and the FULL amount in wnft mode.
    const simulatedWnftSide = isNative ? slotA : slotB
    const simulatedBaseSide = isNative ? slotB : slotA
    const expectedWnftSide = mode === 'nft' ? (wnftRemainder as bigint) : wnftOut
    reconcileExact({ label: 'removeBase', reconstructed: baseOut, onChain: simulatedBaseSide })
    reconcileExact({ label: 'removeWnft', reconstructed: expectedWnftSide, onChain: simulatedWnftSide })
  } else {
    stepQuote = withWarning(
      reQuote,
      'This step depends on a still-pending approval — its own on-chain simulation was skipped and will be re-verified at pre-flight.',
    )
  }

  const { gas, gasSource } = await resolveGasForStep({
    publicClient: ctx.publicClient,
    dataSuffix: attributionSuffixFor(ctx.config),
    address: ctx.chain.router02,
    abi: routerAbi,
    functionName,
    args: callArgs,
    account: validated.recipient,
    value: 0n,
    tokenCount: mode === 'nft' ? tokenIdsBig.length : 0,
    hasPendingApproval,
  })

  const removeStep: Step = {
    kind: 'remove-liquidity',
    label: '',
    tx: {
      to: ctx.chain.router02,
      data,
      value: 0n,
      chainId: ctx.chain.chainId,
      gas,
      ...(gasSource ? { gasSource } : {}),
    },
    approvals: [],
    bounds,
    quote: stepQuote,
    preflightRefs: {
      payer: validated.recipient,
      collection,
      wrapper,
      pair,
      ...(mode === 'nft' ? { buyTokenIds: tokenIds } : {}),
      lpBurn: { amount: lpIn, ...(nftWhole !== undefined ? { nftCount: nftWhole } : {}) },
    },
  }

  const steps: Step[] = approvals.map((a) => buildApprovalStep(a, { quote: reQuote, bounds }))
  steps.push(removeStep)

  return assemblePlan(ctx, steps, reQuote.expiresAt)
}
