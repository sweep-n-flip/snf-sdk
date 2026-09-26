import type { Abi } from 'viem'

import { ROUTER02_COLLECTION_ABI } from '../abis/UniswapV2Router02Collection'
import { ROUTER_NATIVE_ERC20_ABI } from '../abis/UniswapV2Router01CollectionNativeERC20'
import { MAX_TOKEN_IDS, assertTokenIdList } from '../build/validate'
import { assertChainMatch, SnfError } from '../errors'
import { reconcileExact } from '../math/reconcile'
import { assertBaseNotCollection, assertBaseNotWrapper, buildDepositQuote, computeLpOut } from './depositQuote'
import { ONE_WNFT, minErc20Desired, requiredBase } from './liquidityMath'
import { loadDepositState } from './poolState'
import type { SnfClientContext } from '../types/client.types'
import type { QuoteAddLiquidityArgs } from '../types/liquidity.types'
import type { Quote } from '../types/quote.types'

/**
 * On-chain-reconciled quote for depositing `tokenIds` into an EXISTING pool. A pool
 * with no liquidity yet (no pair, or a pair whose reserves are both zero) is
 * `quoteCreatePool`'s job — deciding create-vs-add from LIVE RESERVES (never from
 * whether a `getPair` slot happens to be non-zero) is what keeps a same-block
 * pre-seed from silently landing a caller on the wrong deposit branch: an empty
 * pre-created pair is harmless, a pre-seeded one is exactly the front-run
 * `buildCreatePool`'s exact minimums guard against.
 */

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

interface Call {
  readonly address: `0x${string}`
  readonly abi: Abi
  readonly functionName: string
  readonly args: readonly unknown[]
}
type CallResult = { readonly status: 'success' | 'failure'; readonly result?: unknown }

export async function quoteAddLiquidity(ctx: SnfClientContext, args: QuoteAddLiquidityArgs): Promise<Quote> {
  assertChainMatch(args.chainId, ctx.chain.chainId)
  const tokenIds = assertTokenIdList(args.tokenIds, { field: 'tokenIds', min: 1, max: MAX_TOKEN_IDS })
  const nftCount = tokenIds.length
  assertBaseNotCollection(args.collection, args.baseToken)

  const state = await loadDepositState(ctx, {
    collection: args.collection,
    ...(args.baseToken !== undefined ? { baseToken: args.baseToken } : {}),
  })
  assertBaseNotWrapper(state)

  if (state.pair === null || (state.reserves.base === 0n && state.reserves.wnft === 0n)) {
    throw new SnfError(
      'INVALID_PARAMS',
      'This pool has no liquidity yet — call quoteCreatePool to set its opening price.',
      { details: { field: 'collection', reason: 'no-liquidity' } },
    )
  }
  if (state.feeTo.toLowerCase() !== ZERO_ADDRESS) {
    throw new SnfError(
      'QUOTE_RECONCILIATION_FAILED',
      "This pool's Factory has a live protocol fee — this package's fee-off mint mirror does not apply.",
      { details: { reason: 'protocol-fee-on', feeTo: state.feeTo } },
    )
  }

  const depositWnft = BigInt(nftCount) * ONE_WNFT
  const localRequired = requiredBase(nftCount, state.reserves.wnft, state.reserves.base)

  // Cross-check against the Router's OWN on-chain `quote()`, pinned to the SAME
  // block `loadDepositState` already read above — never a second, independent block.
  const routerAbi = ctx.chain.routerVariant === 'native-erc20' ? ROUTER_NATIVE_ERC20_ABI : ROUTER02_COLLECTION_ABI
  const contracts: Call[] = [
    {
      address: ctx.chain.router02,
      abi: routerAbi,
      functionName: 'quote',
      args: [depositWnft, state.reserves.wnft, state.reserves.base],
    },
  ]
  const results: readonly CallResult[] = await ctx.publicClient.multicall({
    contracts,
    allowFailure: true,
    multicallAddress: ctx.chain.multicall3,
    batchSize: 0,
    blockNumber: state.blockNumber,
  })
  const onChainResult = results[0]
  if (onChainResult?.status !== 'success') {
    throw new SnfError('NO_ROUTE', "Could not read the Router's own quote() for this deposit", {
      details: { pair: state.pair },
    })
  }
  reconcileExact({ label: 'baseRequired', reconstructed: localRequired, onChain: onChainResult.result as bigint })

  const baseDesired = state.isNative ? undefined : minErc20Desired(nftCount, state.reserves.wnft, state.reserves.base)
  const lpOut = computeLpOut(state, depositWnft, localRequired)

  return buildDepositQuote({
    side: 'add-liquidity',
    chainId: ctx.chain.chainId,
    state,
    nftCount,
    tokenIds,
    baseRequired: localRequired,
    ...(baseDesired !== undefined ? { baseDesired } : {}),
    lpOut,
  })
}
