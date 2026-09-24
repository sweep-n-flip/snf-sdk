import { assertParam } from '../errors'
import type { Bounds } from '../types/plan.types'

/**
 * `deriveBounds` — protective bigint slippage rounding, pool axis only.
 *
 * The SDK must never use caller-supplied prices to derive
 * `bounds`/`value`/`amountOutMin` — always re-derive on-chain inside `build()`. This
 * module makes that structural rather than a convention someone could forget:
 * `deriveBounds`'s only numeric input is `total: bigint`, a freshly re-read amount a
 * `build*` function obtains itself — this function's signature has no field carrying
 * the caller's own priced payload, so a caller literally cannot pass one in (this
 * file itself never even imports that shape — see this plan's grep-based static
 * gate, which asserts as much by name-count).
 *
 * Rounding direction always protects the user: a buy's maximum rounds UP (so a 1-wei
 * rounding step can never make the transaction revert for being 1 wei short of the
 * true cost), a sell's minimum rounds DOWN (same reasoning, opposite side). Both are
 * expressed on the **pool** axis — the same decimals `chains/units.ts` calls the
 * pool's own quote-token decimals (18 on 13 chains, 6 on Arc) — because that is the
 * axis the Router's own `require` compares against (`amountInMax`/`amountOutMin` are
 * pool-side arguments to `*Collection`/`getAmountsIn/Out`). The EVM-axis `tx.value` a
 * builder actually sends is derived separately, via `chains/units.ts`'s
 * `toNativeValue` — never here. On Arc the two axes differ by exactly `1e12`
 * (`NATIVE_SCALE`); on every other chain they are numerically identical.
 */

/** Basis-point denominator every slippage bound is scaled against. */
const BPS_DENOM = 10_000n
const MIN_SLIPPAGE_BPS = 0
const MAX_SLIPPAGE_BPS = 10_000

function assertValidSlippageBps(slippageBps: number): void {
  assertParam(
    Number.isInteger(slippageBps) && slippageBps >= MIN_SLIPPAGE_BPS && slippageBps <= MAX_SLIPPAGE_BPS,
    `slippageBps must be an integer between ${MIN_SLIPPAGE_BPS} and ${MAX_SLIPPAGE_BPS}`,
    { field: 'slippageBps', value: slippageBps },
  )
}

/**
 * Ceils `total` widened by `slippageBps` — the "+ denominator - 1" bigint ceil idiom.
 * Used for a buy's `amountInMax`: the Router must never revert because the widened
 * ceiling landed 1 wei below what the true cost needed.
 */
export function applySlippageUp(total: bigint, slippageBps: number): bigint {
  assertValidSlippageBps(slippageBps)
  const bps = BigInt(slippageBps)
  const numerator = total * (BPS_DENOM + bps)
  return (numerator + (BPS_DENOM - 1n)) / BPS_DENOM
}

/**
 * Floors `total` narrowed by `slippageBps`. Used for a sell's `amountOutMin`: the
 * floor guarantees the seller's stated floor is never overstated by a rounding step.
 */
export function applySlippageDown(total: bigint, slippageBps: number): bigint {
  assertValidSlippageBps(slippageBps)
  const bps = BigInt(slippageBps)
  if (bps >= BPS_DENOM) return 0n
  const numerator = total * (BPS_DENOM - bps)
  return numerator / BPS_DENOM
}

export interface DeriveBoundsArgs {
  readonly side: 'buy' | 'sell'
  /** The freshly re-derived on-chain total this bound protects — pool-axis units,
   * NEVER a field lifted from the caller's own priced payload. */
  readonly total: bigint
  readonly slippageBps: number
  /** Absolute unix-seconds deadline, already validated/defaulted by
   * `validate.ts`'s `validateBuildArgs` — carried through unchanged. */
  readonly deadline: bigint
}

/**
 * Derives a `Bounds` for one build step from a fresh on-chain total. `side:
 * 'buy'` populates `amountInMax` (ceil); `side: 'sell'` populates `amountOutMin`
 * (floor). `slippageBps: 0` yields the exact `total` on either side — no drift from
 * the ceil/floor idiom at zero tolerance, asserted by this plan's test suite.
 */
export function deriveBounds(args: DeriveBoundsArgs): Bounds {
  assertValidSlippageBps(args.slippageBps)
  if (args.side === 'buy') {
    return {
      amountInMax: applySlippageUp(args.total, args.slippageBps),
      slippageBps: args.slippageBps,
      deadline: args.deadline,
    }
  }
  return {
    amountOutMin: applySlippageDown(args.total, args.slippageBps),
    slippageBps: args.slippageBps,
    deadline: args.deadline,
  }
}
