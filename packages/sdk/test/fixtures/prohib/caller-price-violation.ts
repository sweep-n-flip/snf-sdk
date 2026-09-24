/**
 * `caller-price-violation.ts` — the DELIBERATE anti-pattern the no-caller-price
 * rule forbids, kept ONLY as a test subject for `test/prohibitions/no-caller-price.test.ts`
 * (`SNF_SDK_PROHIB_SUBJECT`). MUST NEVER be imported by `src/` — `test/prohibitions/
 * no-caller-price.test.ts`'s own `grep -rn "fixtures/prohib" src` acceptance check
 * (and `pnpm grep:gate`, which does not scan `test/`) exist to make that
 * unenforceable-by-accident, not merely discouraged.
 *
 * Same exported name (`deriveBounds`) and the same `side`/`total`/`slippageBps`/
 * `deadline` fields as the real `src/build/bounds.ts` — a genuine drop-in — but this
 * version ALSO reads an optional `callerQuote.totalCost.value` and, when present,
 * substitutes it for the freshly re-quoted `total`. This is the exact bug the rule
 * forbids: a caller who tampers with the `Quote` object they hand to `build()` (e.g.
 * doubling `totalCost.value`) would get a `bounds.amountInMax` computed from THEIR
 * number, not the SDK's own fresh on-chain re-quote — silently letting a malicious or
 * buggy caller under- or over-state what the Router is asked to guarantee.
 */

const BPS_DENOM = 10_000n

interface CallerQuoteLike {
  readonly totalCost?: { readonly value: bigint }
}

export interface DeriveBoundsLikeArgs {
  readonly side: 'buy' | 'sell'
  readonly total: bigint
  readonly slippageBps: number
  readonly deadline: bigint
  /** THE BUG: an optional caller-supplied quote this function should never read. */
  readonly callerQuote?: CallerQuoteLike
}

export interface BoundsLike {
  readonly amountInMax?: bigint
  readonly amountOutMin?: bigint
  readonly slippageBps: number
  readonly deadline: bigint
}

function applyUp(total: bigint, slippageBps: number): bigint {
  const bps = BigInt(slippageBps)
  const numerator = total * (BPS_DENOM + bps)
  return (numerator + (BPS_DENOM - 1n)) / BPS_DENOM
}

function applyDown(total: bigint, slippageBps: number): bigint {
  const bps = BigInt(slippageBps)
  if (bps >= BPS_DENOM) return 0n
  return (total * (BPS_DENOM - bps)) / BPS_DENOM
}

export function deriveBounds(args: DeriveBoundsLikeArgs): BoundsLike {
  // THE VIOLATION: prefers the caller's own priced field over the fresh `total` this
  // function was actually handed — exactly the bug the no-caller-price rule forbids.
  const effectiveTotal = args.callerQuote?.totalCost?.value ?? args.total
  if (args.side === 'buy') {
    return { amountInMax: applyUp(effectiveTotal, args.slippageBps), slippageBps: args.slippageBps, deadline: args.deadline }
  }
  return { amountOutMin: applyDown(effectiveTotal, args.slippageBps), slippageBps: args.slippageBps, deadline: args.deadline }
}
