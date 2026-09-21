import type { Abi } from 'viem'

import { ERC20_ABI } from '../abis/ERC20'
import { ERC721_ABI } from '../abis/ERC721'
import { WERC721_ABI } from '../abis/WERC721'
import { SnfError } from '../errors'
import type { SnfClientContext } from '../types/client.types'
import type { ExecutionPlan, PreflightResult, StepPreflightRefs } from '../types/plan.types'

/**
 * `runPreflight` — the frame-of-signature pre-flight (R14; 54-SPEC.md). Every claim a
 * plan depends on is re-verified against the chain in ONE Multicall3 call at ONE
 * `blockNumber`, immediately before a caller would sign anything. `batchSize: 0`
 * disables viem's own calldata chunking so every read genuinely lands in that one
 * call — chunking would let two reads answer from different blocks under a reorg,
 * which is exactly the drift this function exists to close (Drops `swapGuards.ts`'s
 * header makes the same argument for its own two narrower guards).
 *
 * Non-goals, deliberately: this function does NOT re-quote (that already happened
 * inside `build()`), does NOT mutate `plan`, and does NOT sign or send anything. It
 * is a read-only gate; calling it twice is safe by construction — nothing here is a
 * counter, a cache write, or anything else with memory.
 *
 * Failure precedence is fixed and documented, so the SAME broken state always
 * produces the SAME error: `WRONG_CHAIN` → `WRAPPER_UNVERIFIED` →
 * `TOKENIDS_UNAVAILABLE` → balance `INVALID_PARAMS`.
 */

interface Call {
  readonly address: `0x${string}`
  readonly abi: Abi
  readonly functionName: string
  readonly args: readonly unknown[]
}
type CallResult = { readonly status: 'success' | 'failure'; readonly result?: unknown }

interface OwnershipCheck {
  readonly tokenId: string
  readonly collection: `0x${string}`
  readonly expectedOwner: `0x${string}`
}

function collectRefs(plan: ExecutionPlan): readonly StepPreflightRefs[] {
  const refs: StepPreflightRefs[] = []
  for (const step of plan.steps) {
    if (step.preflightRefs) refs.push(step.preflightRefs)
  }
  return refs
}

function ownershipChecks(refs: readonly StepPreflightRefs[]): readonly OwnershipCheck[] {
  const checks: OwnershipCheck[] = []
  for (const r of refs) {
    for (const id of r.sellTokenIds ?? []) checks.push({ tokenId: id, collection: r.collection, expectedOwner: r.payer })
    // Buy-side custody: the AMM Pair never itself holds the underlying ERC-721 — the
    // WERC721 WRAPPER does (`WERC721.mint` pulls the NFT into the wrapper contract on
    // deposit; the Pair only ever holds the fungible wrapper-token balance). Comparing
    // against `r.pair` here made every genuinely-available buy tokenId look
    // unavailable (Finding 1, snf-54-18-SUMMARY.md; fixed in snf-54-18F) — confirmed
    // live against both the Base and Arc pools in plan 18's fork lanes.
    for (const id of r.buyTokenIds ?? []) checks.push({ tokenId: id, collection: r.collection, expectedOwner: r.wrapper })
  }
  return checks
}

function uniqueBy<T, K>(items: readonly T[], key: (item: T) => K): readonly T[] {
  const seen = new Set<K>()
  const out: T[] = []
  for (const item of items) {
    const k = key(item)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(item)
  }
  return out
}

async function readAll(
  ctx: SnfClientContext,
  contracts: readonly Call[],
  blockNumber: bigint,
): Promise<{ readonly results: readonly CallResult[]; readonly warnings: readonly string[] }> {
  if (contracts.length === 0) return { results: [], warnings: [] }
  try {
    const results = await ctx.publicClient.multicall({
      contracts,
      allowFailure: true,
      multicallAddress: ctx.chain.multicall3,
      batchSize: 0,
      blockNumber,
    })
    return { results, warnings: [] }
  } catch {
    // Sequential fallback — multicall3 itself is missing/non-standard on this chain.
    // Still pinned to the SAME explicit blockNumber; never re-reads at "latest".
    const results = await Promise.all(
      contracts.map(async (c): Promise<CallResult> => {
        try {
          const result = await ctx.publicClient.readContract({ ...c, blockNumber })
          return { status: 'success', result }
        } catch {
          return { status: 'failure' }
        }
      }),
    )
    return {
      results,
      warnings: ['multicall3 was unreachable — degraded to a sequential one-block fallback.'],
    }
  }
}

export async function runPreflight(ctx: SnfClientContext, plan: ExecutionPlan): Promise<PreflightResult> {
  // WRONG_CHAIN first, and needs no on-chain read: `ctx.publicClient` is the
  // partner's own client — if it is itself configured for a different chain than
  // this SDK instance's `ctx.chain`, every read below would silently answer for the
  // wrong network.
  const walletChainId = ctx.publicClient.chain?.id
  if (walletChainId !== undefined && walletChainId !== ctx.chain.chainId) {
    throw new SnfError('WRONG_CHAIN', 'The connected client is on a different chain than this plan.', {
      details: { expected: ctx.chain.chainId, actual: walletChainId },
    })
  }

  const refs = collectRefs(plan)
  const payer = refs[0]?.payer
  const wrappers = uniqueBy(
    refs.map((r) => ({ wrapper: r.wrapper, collection: r.collection })),
    (w) => w.wrapper.toLowerCase(),
  )
  const ownership = ownershipChecks(refs)
  const erc20Base = refs.find((r) => r.erc20Base)?.erc20Base

  const blockNumber = await ctx.publicClient.getBlockNumber()

  const contracts: Call[] = [
    ...wrappers.map((w): Call => ({ address: w.wrapper, abi: WERC721_ABI, functionName: 'collection', args: [] })),
    ...ownership.map(
      (o): Call => ({ address: o.collection, abi: ERC721_ABI, functionName: 'ownerOf', args: [BigInt(o.tokenId)] }),
    ),
    ...(erc20Base && payer
      ? [{ address: erc20Base, abi: ERC20_ABI, functionName: 'balanceOf', args: [payer] } satisfies Call]
      : []),
  ]

  const [{ results, warnings }, nativeBalance] = await Promise.all([
    readAll(ctx, contracts, blockNumber),
    payer !== undefined ? ctx.publicClient.getBalance({ address: payer, blockNumber }) : Promise.resolve(0n),
  ])

  let cursor = 0
  const wrapperResults = results.slice(cursor, cursor + wrappers.length)
  cursor += wrappers.length
  const ownershipResults = results.slice(cursor, cursor + ownership.length)
  cursor += ownership.length
  const erc20Result = erc20Base && payer ? results[cursor] : undefined

  // 1) WRAPPER_UNVERIFIED — any wrapper whose collection() disagrees (or could not be read).
  for (let i = 0; i < wrappers.length; i += 1) {
    const w = wrappers[i]
    const r = wrapperResults[i]
    const onChainCollection = r?.status === 'success' ? (r.result as `0x${string}`) : undefined
    if (w && (onChainCollection === undefined || onChainCollection.toLowerCase() !== w.collection.toLowerCase())) {
      throw new SnfError('WRAPPER_UNVERIFIED', `wrapper ${w.wrapper} did not verify against collection ${w.collection}`, {
        details: { wrapper: w.wrapper, collection: w.collection },
      })
    }
  }

  // 2) TOKENIDS_UNAVAILABLE — collect ALL offending ids before throwing.
  const badIds: string[] = []
  for (let i = 0; i < ownership.length; i += 1) {
    const check = ownership[i]
    const r = ownershipResults[i]
    const owner = r?.status === 'success' ? (r.result as `0x${string}`).toLowerCase() : undefined
    if (check && owner !== check.expectedOwner.toLowerCase()) badIds.push(check.tokenId)
  }
  if (badIds.length > 0) {
    throw new SnfError('TOKENIDS_UNAVAILABLE', 'One or more tokenIds are no longer available for this plan.', {
      details: { tokenIds: badIds },
    })
  }

  // 3) balance INVALID_PARAMS — native first, then the ERC-20 base if this plan spends one.
  const nativeRequired = plan.steps.reduce((sum, step) => sum + step.tx.value, 0n)
  if (nativeRequired > nativeBalance) {
    throw new SnfError('INVALID_PARAMS', 'Insufficient native balance to cover this plan.', {
      details: { field: 'value', required: nativeRequired, available: nativeBalance },
    })
  }
  if (erc20Base && payer) {
    const erc20Required = plan.steps
      .filter((s) => s.preflightRefs?.erc20Base?.toLowerCase() === erc20Base.toLowerCase())
      .reduce((sum, s) => sum + (s.bounds.amountInMax ?? 0n), 0n)
    const erc20Available = erc20Result?.status === 'success' ? (erc20Result.result as bigint) : 0n
    if (erc20Required > erc20Available) {
      throw new SnfError('INVALID_PARAMS', 'Insufficient ERC-20 balance to cover this plan.', {
        details: { field: 'amountInMax', required: erc20Required, available: erc20Available, token: erc20Base },
      })
    }
  }

  return {
    ok: true,
    blockNumber,
    checked: ['ownership', 'pool-holds', 'wrapper-identity', 'balance', 'chain'],
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}
