import type { Abi } from 'viem'

import { ERC20_ABI } from '../abis/ERC20'
import { ERC721_ABI } from '../abis/ERC721'
import { PAIR_ABI } from '../abis/UniswapV2Pair'
import { WERC721_ABI } from '../abis/WERC721'
import { SnfError } from '../errors'
import type { SnfClientContext } from '../types/client.types'
import type { ExecutionPlan, PreflightResult, StepPreflightRefs } from '../types/plan.types'

/**
 * `runPreflight` — the frame-of-signature pre-flight. Every claim a
 * plan depends on is re-verified against the chain in ONE Multicall3 call at ONE
 * `blockNumber`, immediately before a caller would sign anything. `batchSize: 0`
 * disables viem's own calldata chunking so every read genuinely lands in that one
 * call — chunking would let two reads answer from different blocks under a reorg,
 * which is exactly the drift this function exists to close (the same argument other
 * SnF checkout surfaces make for their own narrower pre-flight guards).
 *
 * Non-goals, deliberately: this function does NOT re-quote (that already happened
 * inside `build()`), does NOT mutate `plan`, and does NOT sign or send anything. It
 * is a read-only gate; calling it twice is safe by construction — nothing here is a
 * counter, a cache write, or anything else with memory.
 *
 * Failure precedence is fixed and documented, so the SAME broken state always
 * produces the SAME error: `WRONG_CHAIN` → `WRAPPER_UNVERIFIED` →
 * `TOKENIDS_UNAVAILABLE` → native/ERC-20 balance → LP balance (a later addition) →
 * whole-NFT count (a later addition).
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

/** One `StepPreflightRefs.lpBurn`, resolved and validated against the ref's own
 * `pair`/`wrapper` — a `lpBurn` can only ever be present on a step whose pair (and,
 * for an `nft`-mode burn, whose wrapper) already exists, so a `null` there is an
 * internal invariant violation, not a user-facing input error. */
interface LpBurnCheck {
  readonly payer: `0x${string}`
  readonly pair: `0x${string}`
  readonly wrapper: `0x${string}` | null
  readonly amount: bigint
  readonly nftCount: number | undefined
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
    // unavailable (Finding 1, fixed in) — confirmed
    // live against both the Base and Arc pools later's fork lanes.
    if (r.buyTokenIds && r.buyTokenIds.length > 0) {
      if (r.wrapper === null) {
        throw new SnfError('UNKNOWN', 'internal: a buy-side step cannot reference a null wrapper.')
      }
      for (const id of r.buyTokenIds) checks.push({ tokenId: id, collection: r.collection, expectedOwner: r.wrapper })
    }
  }
  return checks
}

function lpBurnChecks(refs: readonly StepPreflightRefs[]): readonly LpBurnCheck[] {
  const checks: LpBurnCheck[] = []
  for (const r of refs) {
    if (!r.lpBurn) continue
    if (r.pair === null) {
      throw new SnfError('UNKNOWN', 'internal: an lpBurn ref cannot reference a null pair.')
    }
    if (r.lpBurn.nftCount !== undefined && r.wrapper === null) {
      throw new SnfError('UNKNOWN', 'internal: an nft-mode lpBurn ref cannot reference a null wrapper.')
    }
    checks.push({ payer: r.payer, pair: r.pair, wrapper: r.wrapper, amount: r.lpBurn.amount, nftCount: r.lpBurn.nftCount })
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
  // A `null` wrapper means THIS deposit is what creates it — there is no on-chain
  // identity to verify yet, so those refs are excluded from the identity check
  // entirely rather than producing a doomed read.
  const wrappers = uniqueBy(
    refs
      .filter((r): r is StepPreflightRefs & { wrapper: `0x${string}` } => r.wrapper !== null)
      .map((r) => ({ wrapper: r.wrapper, collection: r.collection })),
    (w) => w.wrapper.toLowerCase(),
  )
  const ownership = ownershipChecks(refs)
  const erc20Base = refs.find((r) => r.erc20Base)?.erc20Base
  const lpBurns = lpBurnChecks(refs)

  const blockNumber = await ctx.publicClient.getBlockNumber()

  const contracts: Call[] = [
    ...wrappers.map((w): Call => ({ address: w.wrapper, abi: WERC721_ABI, functionName: 'collection', args: [] })),
    ...ownership.map(
      (o): Call => ({ address: o.collection, abi: ERC721_ABI, functionName: 'ownerOf', args: [BigInt(o.tokenId)] }),
    ),
    ...(erc20Base && payer
      ? [{ address: erc20Base, abi: ERC20_ABI, functionName: 'balanceOf', args: [payer] } satisfies Call]
      : []),
    // Same multicall, same blockNumber as every other read here: an nft-mode burn's
    // whole-NFT count and every balance check below must agree on the exact same
    // on-chain snapshot.
    ...lpBurns.flatMap((b): Call[] => [
      { address: b.pair, abi: PAIR_ABI, functionName: 'balanceOf', args: [b.payer] },
      { address: b.pair, abi: PAIR_ABI, functionName: 'totalSupply', args: [] },
      ...(b.nftCount !== undefined && b.wrapper !== null
        ? [{ address: b.wrapper, abi: WERC721_ABI, functionName: 'balanceOf', args: [b.pair] } satisfies Call]
        : []),
    ]),
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
  if (erc20Base && payer) cursor += 1
  const lpBurnResults = lpBurns.map((b) => {
    const balanceOfResult = results[cursor]
    cursor += 1
    const totalSupplyResult = results[cursor]
    cursor += 1
    const wrapperBalanceResult = b.nftCount !== undefined && b.wrapper !== null ? results[cursor] : undefined
    if (b.nftCount !== undefined && b.wrapper !== null) cursor += 1
    return { burn: b, balanceOfResult, totalSupplyResult, wrapperBalanceResult }
  })

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

  // 4) LP balance INVALID_PARAMS (a later addition) — the payer's live LP balance
  // must cover every lpBurn this plan depends on.
  for (const { burn, balanceOfResult } of lpBurnResults) {
    const lpBalance = balanceOfResult?.status === 'success' ? (balanceOfResult.result as bigint) : 0n
    if (lpBalance < burn.amount) {
      throw new SnfError('INVALID_PARAMS', 'Insufficient LP balance to cover this withdrawal.', {
        details: { field: 'liquidity', required: burn.amount, available: lpBalance },
      })
    }
  }

  // 5) whole-NFT count re-check (a later addition, `nft` mode only) —
  // INSUFFICIENT_OUTPUT_AMOUNT: the exact id count an nft-mode redemption sends
  // on-chain has to match precisely, and reserves can move between build and sign.
  for (const { burn, totalSupplyResult, wrapperBalanceResult } of lpBurnResults) {
    if (burn.nftCount === undefined) continue
    const totalSupply = totalSupplyResult?.status === 'success' ? (totalSupplyResult.result as bigint) : 0n
    const wrapperReserve = wrapperBalanceResult?.status === 'success' ? (wrapperBalanceResult.result as bigint) : 0n
    const actualNftWhole = totalSupply > 0n ? Number((burn.amount * wrapperReserve) / totalSupply / 10n ** 18n) : 0
    if (actualNftWhole !== burn.nftCount) {
      throw new SnfError(
        'INSUFFICIENT_OUTPUT_AMOUNT',
        'The whole-NFT count this withdrawal would produce has changed since it was built — re-quote.',
        { details: { reason: 'nft-count-changed', expected: burn.nftCount, actual: actualNftWhole } },
      )
    }
  }

  return {
    ok: true,
    blockNumber,
    checked: [
      'ownership',
      'pool-holds',
      'wrapper-identity',
      'balance',
      'chain',
      ...(lpBurns.length > 0 ? ['lp-balance'] : []),
      ...(lpBurns.some((b) => b.nftCount !== undefined) ? ['nft-count'] : []),
    ],
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}
