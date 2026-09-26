import { getAddress } from 'viem'
import type { Chain, PublicClient, TransactionReceipt, WalletClient } from 'viem'
import { expect } from 'vitest'

import { ERC721_ABI } from '../../src/abis/ERC721'
import { PAIR_ABI } from '../../src/abis/UniswapV2Pair'
import type { ExecutionPlan } from '../../src/types/plan.types'

/**
 * Shared helpers for the Base liquidity fork lane (`base.liquidity.fork.test.ts`) —
 * split out purely to keep the scenario file itself readable: sending a whole
 * `ExecutionPlan` one step at a time (mirroring the exact for-loop pattern
 * `base.fork.test.ts` already established for its own swap plans) and reading a
 * pair's live reserves in base/wnft terms (the SAME `wrapperIsToken0` orientation
 * dance every quote/build function in `src/liquidity` already performs).
 */

/**
 * Sends every step of a plan, in order, on the SAME wallet client — approvals
 * always precede the swap/deposit/withdrawal step they unblock (`Step[]` ordering
 * invariant), so a plain sequential for-loop with a receipt wait between each step
 * is always correct here. Returns every mined receipt, in the same order.
 */
export async function sendPlanSteps(
  walletClient: WalletClient,
  publicClient: PublicClient,
  chain: Chain,
  plan: ExecutionPlan,
): Promise<readonly TransactionReceipt[]> {
  const receipts: TransactionReceipt[] = []
  for (const step of plan.steps) {
    // eslint-disable-next-line no-await-in-loop -- each step depends on the previous one mining first
    const hash = await walletClient.sendTransaction({
      account: walletClient.account!, // both callers always construct this client WITH an account

      chain,
      to: step.tx.to,
      data: step.tx.data,
      value: step.tx.value,
      gas: step.tx.gas,
    })
    // eslint-disable-next-line no-await-in-loop
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    receipts.push(receipt)
  }
  return receipts
}

export interface PairState {
  readonly reserveBase: bigint
  readonly reserveWnft: bigint
  readonly totalSupply: bigint
  readonly wrapperIsToken0: boolean
}

/**
 * Reads an NFT pair's live `getReserves`/`token0`/`totalSupply`, mapped into
 * base/wnft terms via the wrapper address — the same orientation every
 * `liquidity/*` module already performs (`wrapperIsToken0` can be either token
 * slot; never assumed).
 */
export async function readPairState(
  publicClient: PublicClient,
  pair: `0x${string}`,
  wrapper: `0x${string}`,
): Promise<PairState> {
  const [reserves, token0, totalSupply] = await Promise.all([
    publicClient.readContract({ address: pair, abi: PAIR_ABI, functionName: 'getReserves' }),
    publicClient.readContract({ address: pair, abi: PAIR_ABI, functionName: 'token0' }),
    publicClient.readContract({ address: pair, abi: PAIR_ABI, functionName: 'totalSupply' }),
  ])
  const [reserve0, reserve1] = reserves as readonly [bigint, bigint, number]
  const wrapperIsToken0 = getAddress(token0 as `0x${string}`) === getAddress(wrapper)
  const [reserveWnft, reserveBase] = wrapperIsToken0 ? [reserve0, reserve1] : [reserve1, reserve0]
  return { reserveBase, reserveWnft, totalSupply: totalSupply as bigint, wrapperIsToken0 }
}

/**
 * Reads a PLAIN (non-NFT) pair's live reserves oriented around one token of
 * interest — used for the real WETH/USDC delegate pool this lane reads to price
 * the seed in USDC terms. Generic pair-orientation math, no wrapper concept.
 */
export async function readReservesForToken(
  publicClient: PublicClient,
  pair: `0x${string}`,
  token: `0x${string}`,
): Promise<{ readonly reserveOfToken: bigint; readonly reserveOther: bigint }> {
  const [reserves, token0] = await Promise.all([
    publicClient.readContract({ address: pair, abi: PAIR_ABI, functionName: 'getReserves' }),
    publicClient.readContract({ address: pair, abi: PAIR_ABI, functionName: 'token0' }),
  ])
  const [reserve0, reserve1] = reserves as readonly [bigint, bigint, number]
  const tokenIsToken0 = getAddress(token0 as `0x${string}`) === getAddress(token)
  return tokenIsToken0 ? { reserveOfToken: reserve0, reserveOther: reserve1 } : { reserveOfToken: reserve1, reserveOther: reserve0 }
}

/** Asserts every one of `ids` is currently owned by `owner` on `collection` —
 * shared by both ownership checks this lane performs (post-buy, post-redeem). */
export async function assertAllOwnedBy(
  publicClient: PublicClient,
  collection: `0x${string}`,
  ids: readonly string[],
  owner: `0x${string}`,
): Promise<void> {
  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop -- simple sequential ownership checks, not a hot path
    const currentOwner = await publicClient.readContract({
      address: collection,
      abi: ERC721_ABI,
      functionName: 'ownerOf',
      args: [BigInt(id)],
    })
    expect((currentOwner as string).toLowerCase()).toBe(owner.toLowerCase())
  }
}
