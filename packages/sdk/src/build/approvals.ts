import { encodeFunctionData } from 'viem'
import type { Abi } from 'viem'

import { ERC20_ABI } from '../abis/ERC20'
import { ERC721_ABI } from '../abis/ERC721'
import type { SnfChainId } from '../chains/chains.types'
import type { SnfClientContext } from '../types/client.types'
import type { Approval, Bounds, Step } from '../types/plan.types'
import type { Quote } from '../types/quote.types'

/**
 * `missingApprovals` — the on-chain approval pre-check every `build*` function runs
 * before assembling its swap step. Reads `isApprovedForAll`/
 * `allowance` in ONE multicall and returns ONLY what is actually absent — a wallet
 * that already granted the operator approval, or whose ERC-20 allowance already
 * covers the required amount (`>=`, never `>`), gets no approval step for that leg
 * (DATASHEET §5: "skip any already granted — the builder pre-checks allowances and
 * only lists missing ones").
 *
 * A read that FAILS (the RPC drops the call, or the multicall entry comes back
 * `status: 'failure'`) is treated as MISSING, fail-safe: emitting an unnecessary
 * approval step costs the user one extra confirmation; silently treating an unread
 * allowance as sufficient could send a swap that reverts on a missing allowance
 * after the user already paid gas for the approval-adjacent step. This is a
 * deliberate asymmetry, not an oversight.
 */

export interface MissingApprovalsArgs {
  readonly owner: `0x${string}`
  readonly spender: `0x${string}`
  /** The NFT collection to check `isApprovedForAll(owner, spender)` on, when this
   * build touches whole NFTs. */
  readonly erc721?: { readonly token: `0x${string}` }
  /** The ERC-20 base token to check `allowance(owner, spender) >= amount` on, when
   * this build spends an ERC-20 (never checked for a native-base leg). */
  readonly erc20?: { readonly token: `0x${string}`; readonly amount: bigint }
}

function erc721Note(): string {
  return 'setApprovalForAll(router, true) — once per collection'
}

function erc20Note(): string {
  return 'approve(router, amount) — raises the allowance to cover this swap'
}

function encodeErc721Approval(chainId: SnfChainId, token: `0x${string}`, spender: `0x${string}`): Approval {
  return {
    kind: 'erc721-approval-for-all',
    token,
    spender,
    tx: {
      to: token,
      data: encodeFunctionData({ abi: ERC721_ABI, functionName: 'setApprovalForAll', args: [spender, true] }),
      value: 0n,
      chainId,
    },
    note: erc721Note(),
  }
}

function encodeErc20Approval(
  chainId: SnfChainId,
  token: `0x${string}`,
  spender: `0x${string}`,
  amount: bigint,
): Approval {
  return {
    kind: 'erc20-allowance',
    token,
    spender,
    tx: {
      to: token,
      data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [spender, amount] }),
      value: 0n,
      chainId,
    },
    note: erc20Note(),
  }
}

/** Loosely-typed multicall call/result shape — mirrors `quote/quoteContext.ts`'s
 * identical comment: a batch built from an optional prefix plus an optional tail
 * cannot be precisely position-typed by viem's own inference. */
interface Call {
  readonly address: `0x${string}`
  readonly abi: Abi
  readonly functionName: string
  readonly args: readonly unknown[]
}
type CallResult = { readonly status: 'success' | 'failure'; readonly result?: unknown }

export async function missingApprovals(
  ctx: SnfClientContext,
  args: MissingApprovalsArgs,
): Promise<readonly Approval[]> {
  const { owner, spender, erc721, erc20 } = args
  if (!erc721 && !erc20) return []

  const contracts: Call[] = []
  if (erc721) {
    contracts.push({ address: erc721.token, abi: ERC721_ABI, functionName: 'isApprovedForAll', args: [owner, spender] })
  }
  if (erc20) {
    contracts.push({ address: erc20.token, abi: ERC20_ABI, functionName: 'allowance', args: [owner, spender] })
  }

  const results: readonly CallResult[] = await ctx.publicClient.multicall({
    contracts,
    allowFailure: true,
    multicallAddress: ctx.chain.multicall3,
    batchSize: 0,
  })

  const approvals: Approval[] = []
  let cursor = 0
  if (erc721) {
    const r = results[cursor]
    cursor += 1
    const isApproved = r?.status === 'success' && r.result === true
    if (!isApproved) approvals.push(encodeErc721Approval(ctx.chain.chainId, erc721.token, spender))
  }
  if (erc20) {
    const r = results[cursor]
    cursor += 1
    const allowance = r?.status === 'success' ? (r.result as bigint) : undefined
    const sufficient = allowance !== undefined && allowance >= erc20.amount
    if (!sufficient) approvals.push(encodeErc20Approval(ctx.chain.chainId, erc20.token, spender, erc20.amount))
  }
  return approvals
}

/**
 * Wraps one already-built `Approval` into a full `ExecutionPlan.steps[]` entry
 * (`kind: 'approval'`) — reusing the approval's own `tx` (already carrying a
 * populated `data`, `value: 0n` and an explicit `chainId`) rather than re-encoding
 * anything. `shared.quote`/`shared.bounds` are the SAME quote/bounds every other step
 * in this build carries — an approval step has no economics of its own, it exists
 * only to unblock the swap step(s) that follow it.
 */
export function buildApprovalStep(approval: Approval, shared: { readonly quote: Quote; readonly bounds: Bounds }): Step {
  return Object.freeze({
    kind: 'approval',
    label: approval.note,
    tx: approval.tx,
    approvals: [approval],
    bounds: shared.bounds,
    quote: shared.quote,
  })
}
