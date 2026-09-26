import { assertParam, SnfError } from '../errors'
import { assertBaseNotCollection, assertBaseNotWrapper, buildDepositQuote, computeLpOut } from '../liquidity/depositQuote'
import { MINIMUM_LIQUIDITY, ONE_WNFT, minErc20Desired, mintLiquidity, requiredBase } from '../liquidity/liquidityMath'
import { loadDepositState } from '../liquidity/poolState'
import { buildApprovalStep } from './approvals'
import { applySlippageDown, applySlippageUp } from './bounds'
import { buildDepositStep, depositApprovals, depositBounds } from './liquidityDeposit'
import { assemblePlan } from './plan'
import {
  assertAddress,
  assertTokenIdList,
  DEFAULT_SLIPPAGE_BPS,
  MAX_SEED_TOKEN_IDS,
  MAX_TOKEN_IDS,
  MIN_NEW_POOL_NFTS,
  resolveDeadline,
  sortTokenIdsAscending,
} from './validate'
import type { SnfClientContext } from '../types/client.types'
import type { BuildSeedArgs } from '../types/liquidity.types'
import type { ExecutionPlan, Step } from '../types/plan.types'
import type { Quote } from '../types/quote.types'
import type { DepositPoolState } from '../liquidity/poolState.types'

/**
 * `buildSeed` — an OPTIONAL launch helper that splits up to 500 NFTs into
 * consecutive `'add-liquidity'` steps of at most 50 ids each, every one exact
 * (a create/seed minimum is never loosened — the same same-block pre-seed front-run
 * window `buildCreatePool` closes) and user-driven (one click per step, the same
 * discipline every multi-step SDK flow already follows). A partner who never calls
 * this can still seed a pool with a single plain
 * `addLiquidityETHCollection`/`addLiquidityCollection` call — nothing in this
 * package or its docs may make this a prerequisite.
 *
 * Ids are sorted ascending before encoding for a stable, auditable calldata order
 * across steps — the Router itself does not care about order. Duplicate ids throw
 * rather than silently dedupe: silently dropping a repeated id would deposit fewer
 * NFTs than the caller priced the launch for. The 500-id cap bounds both the step
 * count and the one-block pre-flight's `ownerOf` batch; a launch bigger than that
 * calls this function again — the second call simply lands on the existing-pool
 * path below.
 *
 * The first chunk either creates the pool (an absent or reserve-empty pair — its
 * price is the caller's own `pricePerNft`, exact, nothing to reconcile against) or
 * adds into one that already has liquidity (its price must sit within
 * `priceToleranceBps` of `pricePerNft`, and the actual deposit is priced from the
 * LIVE reserves, never from the caller's own figure — the same rule
 * `quoteAddLiquidity` already enforces: only a genuinely new pool lets its first LP
 * set the price). Every later chunk always adds, at whatever ratio the earlier
 * chunks left behind, walked forward through a SIMULATED pool state (this SDK never
 * re-reads the chain mid-plan) — so its own exact minimum is what the Router will
 * settle on if, and only if, the earlier chunks mined untouched. A trade against the
 * pool between two chunks moves that ratio and makes the later chunk's minimum too
 * tight to satisfy on-chain — the step simply reverts, exactly like any other
 * exact-minimum deposit whose price moved, and the plan has to be rebuilt.
 *
 * The LP destination is always the explicit `lpRecipient` this call was given —
 * there is no default and no burn shortcut; a launch's LP policy is the caller's own
 * choice on every single chunk.
 */

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const MAX_TOLERANCE_BPS = 10_000

const LATER_STEP_WARNING =
  'This step depends on an earlier, still-unconfirmed step of this same plan — a trade against the pool ' +
  'before that step mines would move its price and make this step revert on-chain; rebuild the plan once ' +
  'the earlier step has confirmed.'

function requireAddress(value: `0x${string}` | null | undefined, label: string): `0x${string}` {
  if (value === null || value === undefined) {
    throw new SnfError('UNKNOWN', `internal: ${label} was not resolved`)
  }
  return value
}

/** Returns the SAME `Quote`, with one more entry appended to its (possibly absent)
 * `warnings` array — never mutates the original (mirrors `liquidityDeposit.ts`'s and
 * `buildRemoveLiquidity.ts`'s own private helper of the same name). */
function withWarning(quote: Quote, warning: string): Quote {
  return { ...quote, warnings: [...(quote.warnings ?? []), warning] }
}

/** Splits an already-sorted id list into consecutive chunks of at most `size` ids —
 * never re-orders, never drops an id. */
function splitIntoChunks(ids: readonly string[], size: number): readonly (readonly string[])[] {
  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += size) chunks.push([...ids.slice(i, i + size)])
  return chunks
}

interface ChunkPlan {
  readonly tokenIds: readonly string[]
  readonly nftCount: number
  readonly required: bigint
  readonly ceilDesired: bigint | undefined
  readonly lpOut: bigint
  readonly side: 'create-pool' | 'add-liquidity'
  readonly pricePerNft: bigint | undefined
  readonly reserveWnftBefore: bigint
  readonly reserveBaseBefore: bigint
  readonly totalSupplyBefore: bigint
}

export async function buildSeed(ctx: SnfClientContext, args: BuildSeedArgs): Promise<ExecutionPlan> {
  const now = Math.floor(Date.now() / 1000)

  const collection = assertAddress(args.collection, 'collection')
  const payer = assertAddress(args.payer, 'payer')
  const lpRecipient = assertAddress(args.lpRecipient, 'lpRecipient')
  assertParam(lpRecipient.toLowerCase() !== ZERO_ADDRESS, 'lpRecipient must not be the zero address', {
    field: 'lpRecipient',
    value: args.lpRecipient,
  })
  assertParam(args.pricePerNft > 0n, 'pricePerNft must be a positive bigint', {
    field: 'pricePerNft',
    value: args.pricePerNft,
  })
  const toleranceBps = args.priceToleranceBps ?? ctx.config.defaults?.slippageBps ?? DEFAULT_SLIPPAGE_BPS
  assertParam(
    Number.isInteger(toleranceBps) && toleranceBps >= 0 && toleranceBps <= MAX_TOLERANCE_BPS,
    `priceToleranceBps must be an integer between 0 and ${MAX_TOLERANCE_BPS}`,
    { field: 'priceToleranceBps', value: toleranceBps },
  )
  const deadline = resolveDeadline(args.deadline, now, ctx.config.defaults)

  const sortedIds = sortTokenIdsAscending(
    assertTokenIdList(args.tokenIds, { field: 'tokenIds', min: MIN_NEW_POOL_NFTS, max: MAX_SEED_TOKEN_IDS }),
  )
  const idChunks = splitIntoChunks(sortedIds, MAX_TOKEN_IDS)

  assertBaseNotCollection(collection, args.baseToken)
  const state = await loadDepositState(ctx, {
    collection,
    ...(args.baseToken !== undefined ? { baseToken: args.baseToken } : {}),
  })
  assertBaseNotWrapper(state)

  if (state.feeTo.toLowerCase() !== ZERO_ADDRESS) {
    throw new SnfError(
      'QUOTE_RECONCILIATION_FAILED',
      "This pool's Factory has a live protocol fee — this package's fee-off mint mirror does not apply.",
      { details: { reason: 'protocol-fee-on', feeTo: state.feeTo } },
    )
  }

  const isNative = state.isNative
  const baseTokenAddr = isNative ? undefined : requireAddress(state.baseToken.address, 'state.baseToken.address')
  const isEmpty = state.pair === null || (state.reserves.base === 0n && state.reserves.wnft === 0n)

  if (!isEmpty) {
    // An already-priced pool never lets the caller's own figure decide the deposit —
    // only that its DECLARED price still roughly matches what the pool actually
    // trades at right now (the same guard a same-block pre-seed would otherwise
    // slip past unnoticed).
    const livePricePerNft = requiredBase(1, state.reserves.wnft, state.reserves.base)
    const lowerBound = applySlippageDown(args.pricePerNft, toleranceBps)
    const upperBound = applySlippageUp(args.pricePerNft, toleranceBps)
    if (livePricePerNft < lowerBound || livePricePerNft > upperBound) {
      throw new SnfError(
        'INVALID_PARAMS',
        "This pool's live price is outside the declared tolerance around pricePerNft.",
        {
          details: {
            field: 'pricePerNft',
            reason: 'pool-price-outside-tolerance',
            livePrice: livePricePerNft,
            declared: args.pricePerNft,
          },
        },
      )
    }
  }

  // ── Phase 1 — pure bigint walk over a SIMULATED pool state ────────────────────
  // The first chunk is priced against the REAL, just-read `state` (its own creation
  // or its own add into the live pool); every later chunk is priced against the
  // RUNNING totals this walk itself produces, never against a second on-chain read —
  // this plan's own earlier chunks have not mined yet, so there is nothing newer to
  // read.
  let reserveWnft = state.reserves.wnft
  let reserveBase = state.reserves.base
  let totalSupply = state.totalSupply

  const chunkPlans: ChunkPlan[] = []
  let totalDesired = 0n

  for (let i = 0; i < idChunks.length; i += 1) {
    const tokenIds = idChunks[i]!
    const nftCount = tokenIds.length
    const depositWnft = BigInt(nftCount) * ONE_WNFT
    const isFirst = i === 0
    const isCreate = isFirst && isEmpty

    let required: bigint
    let ceilDesired: bigint | undefined
    let pricePerNftForQuote: bigint | undefined
    if (isCreate) {
      required = args.pricePerNft * BigInt(nftCount)
      ceilDesired = undefined
      pricePerNftForQuote = args.pricePerNft
    } else {
      required = requiredBase(nftCount, reserveWnft, reserveBase)
      ceilDesired = isNative ? undefined : minErc20Desired(nftCount, reserveWnft, reserveBase)
      pricePerNftForQuote = undefined
    }

    // The FIRST chunk reuses the real `state` (its own balance-vs-reserve surplus,
    // and its own null-pair symmetric first-mint branch, both already handled by
    // `computeLpOut`) — every later chunk is a pure mirror of `Pair.mint` over this
    // walk's own running totals, since there is no real balance to read yet.
    const lpOut = isFirst
      ? computeLpOut(state, depositWnft, required)
      : mintLiquidity({ amount0: depositWnft, amount1: required, reserve0: reserveWnft, reserve1: reserveBase, totalSupply })
    if (!isFirst) {
      assertParam(lpOut > 0n, 'This seed step would mint zero (or negative) LP — increase this chunk\'s deposit size.', {
        field: 'liquidity',
        reason: 'insufficient-liquidity-minted',
      })
    }

    chunkPlans.push({
      tokenIds,
      nftCount,
      required,
      ceilDesired,
      lpOut,
      side: isCreate ? 'create-pool' : 'add-liquidity',
      pricePerNft: pricePerNftForQuote,
      reserveWnftBefore: reserveWnft,
      reserveBaseBefore: reserveBase,
      totalSupplyBefore: totalSupply,
    })

    const desired = isNative ? required : (ceilDesired ?? required)
    totalDesired += desired

    // `Pair._update` syncs reserves to balances after every mint — the walk assumes
    // no OTHER deposit lands on this pair between chunks (exactly the assumption a
    // trade between chunks breaks, and exactly why later chunks warn about it).
    totalSupply = isFirst && state.totalSupply === 0n ? lpOut + MINIMUM_LIQUIDITY : totalSupply + lpOut
    reserveWnft += depositWnft
    reserveBase += required
  }

  // ── Phase 2 — one approval check covering every chunk's own desired amount ────
  const approvals = await depositApprovals(ctx, {
    owner: payer,
    spender: ctx.chain.router02,
    collection,
    ...(baseTokenAddr !== undefined ? { erc20Base: { token: baseTokenAddr, amount: totalDesired } } : {}),
  })
  const firstStepHasPendingApproval = approvals.length > 0

  // ── Phase 3 — one Step per chunk ──────────────────────────────────────────────
  const depositSteps: Step[] = []
  for (let i = 0; i < chunkPlans.length; i += 1) {
    const chunk = chunkPlans[i]!
    const isFirst = i === 0

    const chunkState: DepositPoolState = isFirst
      ? state
      : {
          blockNumber: state.blockNumber,
          collection: state.collection,
          wrapper: state.wrapper,
          pair: state.pair,
          baseToken: state.baseToken,
          isNative: state.isNative,
          baseIsWrapper: state.baseIsWrapper,
          wrapperIsToken0: state.wrapperIsToken0,
          reserves: { base: chunk.reserveBaseBefore, wnft: chunk.reserveWnftBefore },
          balances: { base: chunk.reserveBaseBefore, wnft: chunk.reserveWnftBefore },
          totalSupply: chunk.totalSupplyBefore,
          feeTo: state.feeTo,
        }

    const bounds = depositBounds({
      mode: 'exact',
      isNative,
      required: chunk.required,
      ...(chunk.ceilDesired !== undefined ? { ceilDesired: chunk.ceilDesired } : {}),
    })

    const chunkQuote = buildDepositQuote({
      side: chunk.side,
      chainId: ctx.chain.chainId,
      state: chunkState,
      nftCount: chunk.nftCount,
      tokenIds: chunk.tokenIds,
      baseRequired: chunk.required,
      ...(chunk.ceilDesired !== undefined ? { baseDesired: chunk.ceilDesired } : {}),
      lpOut: chunk.lpOut,
      ...(chunk.pricePerNft !== undefined ? { pricePerNft: chunk.pricePerNft } : {}),
    })

    // Every step after the first depends on an earlier, still-unconfirmed step of
    // THIS SAME plan — its own on-chain simulation would run against chain state
    // that does not yet reflect the earlier step, so it is skipped exactly like a
    // still-pending approval is (the deterministic NFT-batch fallback gas, never a
    // live estimate, applies here for the same reason).
    const step = await buildDepositStep(ctx, {
      quote: chunkQuote,
      collection,
      wrapper: state.wrapper,
      pair: state.pair,
      isNative,
      ...(baseTokenAddr !== undefined ? { baseToken: baseTokenAddr } : {}),
      tokenIds: chunk.tokenIds,
      nftCount: chunk.nftCount,
      desired: bounds.desired,
      min: bounds.min,
      to: lpRecipient,
      payer,
      deadline,
      slippageBps: 0,
      hasPendingApproval: isFirst ? firstStepHasPendingApproval : true,
      ...(!isFirst ? { dependsOnPriorStep: true } : {}),
    })

    depositSteps.push(isFirst ? step : { ...step, quote: withWarning(step.quote, LATER_STEP_WARNING) })
  }

  const approvalSteps: Step[] = approvals.map((a) =>
    buildApprovalStep(a, { quote: depositSteps[0]!.quote, bounds: depositSteps[0]!.bounds }),
  )

  const expiresAt = new Date(
    Math.min(...depositSteps.map((s) => new Date(s.quote.expiresAt).getTime())),
  ).toISOString()

  return assemblePlan(ctx, [...approvalSteps, ...depositSteps], expiresAt)
}
