import type { Abi } from 'viem'

import { ROUTER02_COLLECTION_ABI } from '../abis/UniswapV2Router02Collection'
import { ROUTER_NATIVE_ERC20_ABI } from '../abis/UniswapV2Router01CollectionNativeERC20'
import { attributionSuffixFor } from '../attribution/sdkSuffix'
import type { RouterVariant, SnfChainId } from '../chains/chains.types'
import { toNativeValue } from '../chains/units'
import { SnfError } from '../errors'
import { ONE_WNFT } from '../liquidity/liquidityMath'
import { reconcileExact } from '../math/reconcile'
import type { SnfClientContext } from '../types/client.types'
import type { Approval, Bounds, Step } from '../types/plan.types'
import type { Quote } from '../types/quote.types'
import { missingApprovals } from './approvals'
import { encodeDynamic, simulateDynamic } from './dynamicCall'
import { applySlippageDown, applySlippageUp } from './bounds'
import { creationOverheadGas, resolveGasForStep } from './gas'

/**
 * `liquidityDeposit` — the shared machinery every deposit builder (`buildAddLiquidity`,
 * `buildCreatePool`, and later `buildSeed`) composes: deciding the deposit's own
 * `desired`/`min` bound, encoding the Router call for whichever base/chain variant
 * applies, pre-checking the ERC-721 (and, for an ERC-20 base, the allowance)
 * approvals, and assembling the one `'add-liquidity'` `Step` every deposit path
 * returns.
 */

// ── depositBounds ──────────────────────────────────────────────────────────────

export interface DepositBoundsArgs {
  /** `'exact'`: a pool-creating deposit (create/seed) — `min` MUST equal the
   * intended amount, never a looser bound. Passing anything less on an empty pair
   * is the exact same-block front-run window a pre-seeded pair exploits, because
   * `_addLiquidity` never even reads the minimums when both reserves are zero.
   * `'slippage'`: a deposit into an already-priced pool — the ordinary protective
   * ceil-up/floor-down slippage bound. */
  readonly mode: 'exact' | 'slippage'
  readonly isNative: boolean
  /** The base the Router actually needs at the reserves this deposit was quoted
   * against — the exact figure the minimum always protects. */
  readonly required: bigint
  /** ERC-20 base only: the ceil amount `minErc20Desired` computed — the desired/
   * approval figure must cover this, never the Router's own floor (`required`),
   * which reverts `INSUFFICIENT_B_AMOUNT`. Ignored for a native deposit. Omitted on
   * `'exact'` defaults to `required` (create/seed have no floor/ceil rounding trap —
   * the caller's own chosen amount IS both the desired and the minimum). */
  readonly ceilDesired?: bigint
  /** Required when `mode === 'slippage'`. */
  readonly slippageBps?: number
}

export interface DepositBoundsResult {
  readonly desired: bigint
  readonly min: bigint
}

/**
 * The ONE place a deposit's minimum is decided. `mode: 'exact'` NEVER returns a
 * `min` below `required` — that is the whole point: with empty reserves the Router
 * never reads the minimums at all, so anything looser than the intended amount lets
 * a same-block pre-seed settle the deposit at an attacker's price.
 */
export function depositBounds(args: DepositBoundsArgs): DepositBoundsResult {
  const { mode, isNative, required } = args
  if (mode === 'exact') {
    const desired = isNative ? required : (args.ceilDesired ?? required)
    return { desired, min: required }
  }
  const slippageBps = args.slippageBps ?? 0
  const min = applySlippageDown(required, slippageBps)
  if (isNative) {
    return { desired: applySlippageUp(required, slippageBps), min }
  }
  const ceilBase = args.ceilDesired ?? required
  return { desired: applySlippageUp(ceilBase, slippageBps), min }
}

// ── encodeDepositCall ───────────────────────────────────────────────────────────

export interface EncodeDepositCallArgs {
  readonly chainId: SnfChainId
  readonly routerVariant: RouterVariant
  readonly isNative: boolean
  readonly collection: `0x${string}`
  /** Required for an ERC-20 deposit; ignored for native. */
  readonly baseToken?: `0x${string}`
  readonly tokenIds: readonly bigint[]
  readonly desired: bigint
  readonly min: bigint
  readonly to: `0x${string}`
  readonly deadline: bigint
}

export interface EncodedDepositCall {
  readonly abi: Abi
  readonly functionName: string
  readonly args: readonly unknown[]
  readonly data: `0x${string}`
  readonly value: bigint
}

/**
 * Encodes the Router call for a deposit — `addLiquidityETHCollection` (native,
 * `value` = the wei equivalent of `desired`) or `addLiquidityCollection` (ERC-20,
 * `value: 0n`), on whichever ABI variant `routerVariant` selects (Arc's
 * `native-erc20` Router inherits the same signatures unchanged).
 */
export function encodeDepositCall(args: EncodeDepositCallArgs): EncodedDepositCall {
  const abi = args.routerVariant === 'native-erc20' ? ROUTER_NATIVE_ERC20_ABI : ROUTER02_COLLECTION_ABI

  if (args.isNative) {
    const functionName = 'addLiquidityETHCollection'
    const callArgs = [args.collection, args.tokenIds, args.min, args.to, args.deadline] as const
    return {
      abi,
      functionName,
      args: callArgs,
      data: encodeDynamic(abi, functionName, callArgs),
      value: toNativeValue(args.chainId, args.desired),
    }
  }

  if (args.baseToken === undefined) {
    throw new SnfError('UNKNOWN', 'internal: encodeDepositCall requires baseToken for a non-native deposit')
  }
  const functionName = 'addLiquidityCollection'
  const callArgs = [args.baseToken, args.collection, args.desired, args.tokenIds, args.min, args.to, args.deadline] as const
  return {
    abi,
    functionName,
    args: callArgs,
    data: encodeDynamic(abi, functionName, callArgs),
    value: 0n,
  }
}

// ── depositApprovals ────────────────────────────────────────────────────────────

export interface DepositApprovalsArgs {
  readonly owner: `0x${string}`
  readonly spender: `0x${string}`
  readonly collection: `0x${string}`
  /** ERC-20 base only: the allowance must cover the DESIRED (buffered) amount, never
   * the amount the Router ends up actually pulling — see `depositBounds`'s own
   * `ceilDesired` doc comment for why the desired figure is deliberately generous. */
  readonly erc20Base?: { readonly token: `0x${string}`; readonly amount: bigint }
}

/** `missingApprovals`, pre-shaped for a deposit: the collection's operator approval,
 * plus (ERC-20 base only) an allowance covering the desired amount. */
export async function depositApprovals(
  ctx: SnfClientContext,
  args: DepositApprovalsArgs,
): Promise<readonly Approval[]> {
  return missingApprovals(ctx, {
    owner: args.owner,
    spender: args.spender,
    erc721: { token: args.collection },
    ...(args.erc20Base ? { erc20: args.erc20Base } : {}),
  })
}

// ── buildDepositStep ─────────────────────────────────────────────────────────────

function requireBigint(value: bigint | undefined, label: string): bigint {
  if (value === undefined) throw new SnfError('UNKNOWN', `internal: ${label} was not derived by the re-quote`)
  return value
}

/** Returns the SAME `Quote`, with one more entry appended to its (possibly absent)
 * `warnings` array — never mutates the original. */
function withWarning(quote: Quote, warning: string): Quote {
  return { ...quote, warnings: [...(quote.warnings ?? []), warning] }
}

export interface BuildDepositStepArgs {
  /** Identity-only, ALREADY a fresh re-quote (never the caller's own) — its
   * `liquidity.baseRequired`/`liquidity.lpOut` are this deposit's exact-mirror
   * figures, reconciled against below. */
  readonly quote: Quote
  readonly collection: `0x${string}`
  /** `null`: this step's own deposit is what creates it. */
  readonly wrapper: `0x${string}` | null
  /** `null`: this step's own deposit is what creates it. */
  readonly pair: `0x${string}` | null
  readonly isNative: boolean
  readonly baseToken?: `0x${string}`
  readonly tokenIds: readonly string[]
  readonly nftCount: number
  readonly desired: bigint
  readonly min: bigint
  /** LP destination. */
  readonly to: `0x${string}`
  /** The payer/signer — the same address a pre-flight ownership check runs against. */
  readonly payer: `0x${string}`
  readonly deadline: bigint
  readonly slippageBps: number
  readonly hasPendingApproval: boolean
  /** Present when this step's own transaction ALSO creates the pair/wrapper — see
   * `build/gas.ts#creationOverheadGas`. */
  readonly extraFallbackGas?: bigint
  /** A later addition (`buildSeed`'s later chunks): this step depends on an EARLIER,
   * still-unconfirmed step of the same plan. */
  readonly dependsOnPriorStep?: boolean
}

/**
 * Assembles the one `'add-liquidity'` `Step` a deposit builder returns. With no
 * pending approval, simulates the REAL Router call at the quote's own pinned block
 * and reconciles the returned amounts/liquidity against the quote's own mirror
 * figures (`===`-only — see `math/reconcile.ts`'s header) — this is what catches a
 * fee-on-transfer or otherwise non-standard ERC-20 base silently minting less LP
 * than expected. With a pending approval, the simulation is skipped (it is
 * guaranteed to revert against CURRENT state) and a warning is attached to the
 * step's own quote instead.
 */
export async function buildDepositStep(ctx: SnfClientContext, args: BuildDepositStepArgs): Promise<Step> {
  const {
    quote,
    collection,
    wrapper,
    pair,
    isNative,
    baseToken,
    tokenIds,
    nftCount,
    desired,
    min,
    to,
    payer,
    deadline,
    slippageBps,
    hasPendingApproval,
    extraFallbackGas,
    dependsOnPriorStep,
  } = args

  const tokenIdsBig = tokenIds.map((id) => BigInt(id))
  const encoded = encodeDepositCall({
    chainId: ctx.chain.chainId,
    routerVariant: ctx.chain.routerVariant,
    isNative,
    collection,
    ...(baseToken !== undefined ? { baseToken } : {}),
    tokenIds: tokenIdsBig,
    desired,
    min,
    to,
    deadline,
  })

  let stepQuote = quote
  if (!hasPendingApproval) {
    const blockNumber = requireBigint(quote.liquidity?.blockNumber, 'liquidity.blockNumber')
    const result = await simulateDynamic(ctx.publicClient, {
      address: ctx.chain.router02,
      abi: encoded.abi,
      functionName: encoded.functionName,
      args: encoded.args,
      account: payer,
      value: encoded.value,
      blockNumber,
    })
    const [rSlotA, rSlotB, simulatedLp] = result as readonly [bigint, bigint, bigint]
    // native: (amountToken=wnft, amountETH=base, liquidity); ERC-20: (amountA=base,
    // amountB=wnft, liquidity) — see `encodeDepositCall`'s two function shapes.
    const simulatedWnft = isNative ? rSlotA : rSlotB
    const simulatedBase = isNative ? rSlotB : rSlotA
    const expectedWnft = BigInt(nftCount) * ONE_WNFT
    const expectedBase = requireBigint(quote.liquidity?.baseRequired?.value, 'liquidity.baseRequired')
    const expectedLp = requireBigint(quote.liquidity?.lpOut?.value, 'liquidity.lpOut')
    reconcileExact({ label: 'depositWnft', reconstructed: expectedWnft, onChain: simulatedWnft })
    reconcileExact({ label: 'depositBase', reconstructed: expectedBase, onChain: simulatedBase })
    reconcileExact({ label: 'depositLpOut', reconstructed: expectedLp, onChain: simulatedLp })
  } else {
    stepQuote = withWarning(
      quote,
      'This step depends on a still-pending approval — its own on-chain simulation was skipped and will be re-verified at pre-flight.',
    )
  }

  const overheadGas = creationOverheadGas({ createsPair: pair === null, createsWrapper: wrapper === null })
  const { gas, gasSource } = await resolveGasForStep({
    publicClient: ctx.publicClient,
    dataSuffix: attributionSuffixFor(ctx.config),
    address: ctx.chain.router02,
    abi: encoded.abi,
    functionName: encoded.functionName,
    args: encoded.args,
    account: payer,
    value: encoded.value,
    tokenCount: nftCount,
    hasPendingApproval,
    extraFallbackGas: (extraFallbackGas ?? 0n) + overheadGas,
    ...(dependsOnPriorStep !== undefined ? { dependsOnPriorStep } : {}),
  })

  const bounds: Bounds = { amountInMax: desired, amountInMin: min, slippageBps, deadline }

  return {
    kind: 'add-liquidity',
    label: '',
    tx: {
      to: ctx.chain.router02,
      data: encoded.data,
      value: encoded.value,
      chainId: ctx.chain.chainId,
      gas,
      ...(gasSource ? { gasSource } : {}),
    },
    approvals: [],
    bounds,
    quote: stepQuote,
    preflightRefs: {
      payer,
      collection,
      wrapper,
      pair,
      sellTokenIds: tokenIds,
      ...(baseToken !== undefined ? { erc20Base: baseToken } : {}),
    },
  }
}
