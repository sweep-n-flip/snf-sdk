import { DEFAULT_SLIPPAGE_BPS, assertTokenIdList } from '../build/validate'
import { applySlippageDown } from '../build/bounds'
import { assertChainMatch, assertParam, SnfError } from '../errors'
import { bpsFromRatio, toAmount, toPoolAmount } from '../format'
import { poolInventory } from '../inventory/poolInventory'
import { MINIMUM_LIQUIDITY, ONE_WNFT, burnAmounts, fromPairOrder, toPairOrder, wholeNfts } from './liquidityMath'
import { loadPairState } from './poolState'
import { probeRedemption } from './redemptionStatus'
import type { SnfClientContext } from '../types/client.types'
import type { LiquidityQuoteDetails, QuoteRemoveLiquidityArgs } from '../types/liquidity.types'
import type { FeeBreakdown, Quote } from '../types/quote.types'

/**
 * On-chain-reconciled quote for withdrawing `liquidity`/`bps` LP from an EXISTING
 * pair, in either `nft` mode (whole NFTs + a fractional wNFT remainder) or `wnft`
 * mode (the fungible wrapper only, at any share size). Both modes burn the SAME
 * `Pair.burn` figures — `liquidity * balanceOf(pair) / totalSupply` for each token,
 * over the pair's OWN balances, never the cached `getReserves` values — the two
 * modes differ only in how the wNFT side is then delivered.
 */

const LP_DECIMALS = 18
const LP_SYMBOL = 'LP'
const WNFT_DECIMALS = 18
const WNFT_SYMBOL = 'wNFT'
const QUOTE_TTL_MS = 30_000
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

function zeroLiquidityFees(baseToken: { readonly symbol: string; readonly decimals: number }): FeeBreakdown {
  return {
    pool: { bps: 0, note: 'no fee applies to a liquidity deposit or withdrawal' },
    marketplace: { ...toPoolAmount(baseToken, 0n), bps: 0 },
    royalty: { ...toPoolAmount(baseToken, 0n), bps: 0, capApplied: false },
  }
}

/** Validates the `liquidity`/`bps` XOR and, when `bps` is used, its 1..10000 integer
 * range — pure, no on-chain read needed, so this runs before `loadPairState`. */
function assertExactlyOneAmountSelector(args: QuoteRemoveLiquidityArgs): void {
  const hasLiquidity = args.liquidity !== undefined
  const hasBps = args.bps !== undefined
  assertParam(hasLiquidity !== hasBps, 'exactly one of liquidity or bps is required', {
    field: hasLiquidity && hasBps ? 'liquidity' : 'bps',
    reason: hasLiquidity && hasBps ? 'both-supplied' : 'neither-supplied',
  })
  if (hasBps) {
    const bps = args.bps
    assertParam(
      Number.isInteger(bps) && bps >= 1 && bps <= 10_000,
      'bps must be an integer between 1 and 10000',
      { field: 'bps', value: bps },
    )
  }
}

export async function quoteRemoveLiquidity(ctx: SnfClientContext, args: QuoteRemoveLiquidityArgs): Promise<Quote> {
  assertChainMatch(args.chainId, ctx.chain.chainId)
  assertExactlyOneAmountSelector(args)

  if (args.mode === 'wnft') {
    assertParam((args.tokenIds ?? []).length === 0, 'wnft mode does not redeem tokenIds', {
      field: 'tokenIds',
      reason: 'wnft-mode-no-tokenids',
    })
  }
  if (args.tokenIds !== undefined) {
    assertTokenIdList(args.tokenIds, { field: 'tokenIds' })
  }

  const state = await loadPairState(ctx, { pair: args.pair, owner: args.owner })
  if (state.feeTo.toLowerCase() !== ZERO_ADDRESS) {
    throw new SnfError(
      'QUOTE_RECONCILIATION_FAILED',
      "This pool's Factory has a live protocol fee — this package's fee-off burn mirror does not apply.",
      { details: { reason: 'protocol-fee-on', feeTo: state.feeTo } },
    )
  }

  const ownerLp = state.ownerLp ?? 0n
  let liquidityAmt: bigint
  if (args.bps !== undefined) {
    liquidityAmt = (ownerLp * BigInt(args.bps)) / 10_000n
  } else {
    liquidityAmt = args.liquidity as bigint
    assertParam(liquidityAmt > 0n, 'liquidity must be a positive amount', {
      field: 'liquidity',
      value: liquidityAmt,
    })
    assertParam(liquidityAmt <= ownerLp, "liquidity exceeds the owner's live LP balance", {
      field: 'liquidity',
      required: liquidityAmt,
      available: ownerLp,
    })
  }

  const balancesOrder = toPairOrder(state.wrapperIsToken0, state.balances)
  const burned = burnAmounts({
    liquidity: liquidityAmt,
    balance0: balancesOrder.v0,
    balance1: balancesOrder.v1,
    totalSupply: state.totalSupply,
  })
  const { base: baseOut, wnft: wnftOut } = fromPairOrder(state.wrapperIsToken0, { v0: burned.amount0, v1: burned.amount1 })
  assertParam(baseOut > 0n && wnftOut > 0n, 'This withdrawal would burn zero (or negative) of one of the two tokens.', {
    field: 'liquidity',
    reason: 'insufficient-liquidity-burned',
  })

  const warnings: string[] = []

  let nftWhole: number | undefined
  let wnftRemainder: bigint | undefined
  let tokenIds: readonly string[] | undefined
  if (args.mode === 'nft') {
    nftWhole = wholeNfts(wnftOut)
    if (nftWhole === 0) {
      throw new SnfError(
        'INVALID_PARAMS',
        'This share is too small to redeem even one whole NFT — use wnft mode instead.',
        { details: { field: 'mode', reason: 'no-whole-nft', suggestedMode: 'wnft' } },
      )
    }

    const redemption = await probeRedemption(ctx, { collection: state.collection, wrapper: state.wrapper, pair: state.pair })
    if (redemption.status === 'blocked') {
      throw new SnfError(
        'REDEMPTION_LOCKED',
        'This collection blocks NFTs from leaving its wrapper, so an nft-mode withdrawal would revert.',
        { details: { collection: state.collection, wrapper: state.wrapper, suggestedMode: 'wnft' } },
      )
    }

    if (args.tokenIds !== undefined) {
      assertParam(args.tokenIds.length === nftWhole, 'tokenIds must exactly match the whole-NFT count this withdrawal produces', {
        field: 'tokenIds',
        reason: 'count-mismatch',
        expected: nftWhole,
        received: args.tokenIds.length,
      })
      tokenIds = args.tokenIds
    } else {
      const inventory = await poolInventory(ctx, state.pair)
      if (inventory.tokenIds.length < nftWhole) {
        throw new SnfError('TOKENIDS_UNAVAILABLE', 'Not enough candidate tokenIds are available for this withdrawal.', {
          details: { required: nftWhole, available: inventory.tokenIds.length },
        })
      }
      tokenIds = inventory.tokenIds.slice(0, nftWhole)
    }
    wnftRemainder = wnftOut - BigInt(nftWhole) * ONE_WNFT

    const shiftedWhole = wholeNfts(applySlippageDown(wnftOut, DEFAULT_SLIPPAGE_BPS))
    if (shiftedWhole !== nftWhole) {
      warnings.push(
        'The whole-NFT count this withdrawal produces is close to an integer boundary — default slippage could shift it by one NFT between quoting and signing; pre-flight re-checks the exact count at signing time.',
      )
    }
  }

  if (state.totalSupply - liquidityAmt === MINIMUM_LIQUIDITY) {
    warnings.push(
      'This withdrawal drains every unit of LP still in circulation — the 1000-unit minimum locked at the pool\'s first deposit stays behind forever, so the actual payout is very slightly less than the pool\'s full reserve share.',
    )
  }

  const liquidity: LiquidityQuoteDetails = {
    pair: state.pair,
    wrapper: state.wrapper,
    baseToken: state.baseToken,
    wrapperIsToken0: state.wrapperIsToken0,
    reserves: state.reserves,
    totalSupply: state.totalSupply,
    blockNumber: state.blockNumber,
    nftCount: nftWhole ?? 0,
    owner: args.owner,
    lpIn: toAmount(liquidityAmt, LP_DECIMALS, LP_SYMBOL),
    baseOut: toPoolAmount(state.baseToken, baseOut),
    wnftOut: toAmount(wnftOut, WNFT_DECIMALS, WNFT_SYMBOL),
    ...(nftWhole !== undefined ? { nftWhole } : {}),
    ...(wnftRemainder !== undefined ? { wnftRemainder: toAmount(wnftRemainder, WNFT_DECIMALS, WNFT_SYMBOL) } : {}),
    mode: args.mode,
    shareBps: bpsFromRatio(liquidityAmt, state.totalSupply),
    feeToZero: true,
  }

  return {
    side: 'remove-liquidity',
    chainId: ctx.chain.chainId,
    collection: state.collection,
    ...(tokenIds !== undefined ? { tokenIds } : {}),
    legs: [],
    fees: zeroLiquidityFees(state.baseToken),
    liquidity,
    totalProceeds: toPoolAmount(state.baseToken, baseOut),
    priceImpact: 0,
    deliverable: nftWhole ?? 0,
    bestEffort: false,
    expiresAt: new Date(Date.now() + QUOTE_TTL_MS).toISOString(),
    reconciled: true,
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}
