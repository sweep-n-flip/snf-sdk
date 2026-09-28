import { SnfError } from '../errors'
import { bpsFromRatio, toAmount, toPoolAmount } from '../format'
import { burnAmounts, fromPairOrder, toPairOrder, wholeNfts } from './liquidityMath'
import { loadPairState } from './poolState'
import type { SnfClientContext } from '../types/client.types'
import type { LpPosition } from '../types/liquidity.types'
import type { PairPoolState } from './poolState.types'

/**
 * `lpPosition(pair, owner)` — the single-pair LP-holder primitive: live balance,
 * share of the pool, and the underlying base/wNFT/whole-NFT breakdown that same
 * balance would burn for RIGHT NOW, at one block. A zero balance is a perfectly
 * valid answer (a wallet that has never provided liquidity to this pair) — it never
 * throws for that reason, only for a genuinely unreadable/spoofed pair or a live
 * protocol fee (see below).
 *
 * The underlying breakdown is the SAME `Pair.burn` mirror (`liquidityMath.burnAmounts`,
 * over the pair's own balances, not the cached `getReserves` values) that
 * `quoteRemoveLiquidity` uses for an actual withdrawal — this function's own
 * `feeTo != 0` guard exists for the identical reason `LiquidityQuoteDetails.feeToZero`
 * does: the mirror is only exact when the Pair's protocol-fee mint is off.
 *
 * `lpPositionFromState` is the pure half of that computation, taking an
 * already-loaded `PairPoolState` instead of doing its own read. It exists so a
 * caller that already holds a block-pinned state for several pairs at once (a
 * whole-wallet scan) can reuse the exact same mirror for every pair without a
 * second `loadPairState` round trip per pair — `lpPosition` itself is nothing
 * more than `loadPairState` followed by this function.
 */

const LP_DECIMALS = 18
const LP_SYMBOL = 'LP'
const WNFT_DECIMALS = 18
const WNFT_SYMBOL = 'wNFT'
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

export function lpPositionFromState(state: PairPoolState, owner: `0x${string}`): LpPosition {
  if (state.feeTo.toLowerCase() !== ZERO_ADDRESS) {
    throw new SnfError(
      'QUOTE_RECONCILIATION_FAILED',
      "This pool's Factory has a live protocol fee — this package's fee-off burn mirror does not apply.",
      { details: { reason: 'protocol-fee-on', feeTo: state.feeTo } },
    )
  }

  const ownerLp = state.ownerLp ?? 0n
  const balancesOrder = toPairOrder(state.wrapperIsToken0, state.balances)
  const burned = burnAmounts({
    liquidity: ownerLp,
    balance0: balancesOrder.v0,
    balance1: balancesOrder.v1,
    totalSupply: state.totalSupply,
  })
  const { base, wnft } = fromPairOrder(state.wrapperIsToken0, { v0: burned.amount0, v1: burned.amount1 })

  return {
    pair: state.pair,
    owner,
    lpBalance: toAmount(ownerLp, LP_DECIMALS, LP_SYMBOL),
    totalSupply: state.totalSupply,
    shareBps: bpsFromRatio(ownerLp, state.totalSupply),
    underlying: {
      base: toPoolAmount(state.baseToken, base),
      wnft: toAmount(wnft, WNFT_DECIMALS, WNFT_SYMBOL),
      nftWhole: wholeNfts(wnft),
    },
    blockNumber: state.blockNumber,
  }
}

export async function lpPosition(
  ctx: SnfClientContext,
  pair: `0x${string}`,
  owner: `0x${string}`,
): Promise<LpPosition> {
  const state = await loadPairState(ctx, { pair, owner })
  return lpPositionFromState(state, owner)
}
