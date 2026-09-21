import { getChain } from './registry'

/**
 * The two-unit-axes module (R2, R11; 54-SPEC.md) — the ONLY place in this package
 * allowed to convert between the pool side and the EVM side of an amount.
 *
 * The pool side (`getReserves`, `getAmountsIn/OutCollection`, `amountOutMin`,
 * `amountInMax`) is always expressed in `quoteDecimals` — 18 on 13 chains, 6 on Arc.
 * The EVM side (`tx.value`, `eth_getBalance`, gas) is always 18. Confusing the two on
 * Arc is a 1,000,000x pricing error, not a rounding error — this is exactly the
 * regression class `snf-client`'s Phase-83 (Arc Pricing Dynamics) fixed across five
 * real call sites (nftToNftMath.ts, confirmSwapHandlers.ts, usePoolList.ts, useSwap.ts,
 * useSwapExecute.ts — see `docs/ARC_PRICING_DYNAMICS.md`). A future multi-hop or
 * cross-pool SDK builder must route every conversion through this module, never
 * through a bare `1e18`/`parseEther`/`parseUnits(x, 18)` literal.
 */

// TODO(54-04): replace with SnfError once errors.ts lands (plan 04, wave 3).
class UnitsError extends Error {
  readonly code = 'INVALID_PARAMS' as const
  readonly details: Record<string, unknown>

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'UnitsError'
    this.details = details
  }
}

/** Decimals of the Router's `WETH()` token (the pool quote token) for `chainId`. */
export function getQuoteDecimals(chainId: number): number {
  return getChain(chainId).quoteDecimals
}

/**
 * `10n ** (18n - quoteDecimals)` — multiply a quote-unit amount by this to get the wei
 * to send as `msg.value`; divide wei by it to get quote units. `1n` on every WETH9
 * chain, `1_000_000_000_000n` on Arc.
 */
export function getQuoteScale(chainId: number): bigint {
  const decimals = getQuoteDecimals(chainId)
  if (decimals > 18) {
    throw new UnitsError(`quoteDecimals ${decimals} for chain ${chainId} exceeds 18`, {
      chainId,
      decimals,
    })
  }
  const exp = 18 - decimals
  if (exp <= 0) return 1n
  return 10n ** BigInt(exp)
}

/** Quote units (what the Pair/Router speak) → wei for `msg.value`. */
export function toNativeValue(chainId: number, amountQuote: bigint): bigint {
  return amountQuote * getQuoteScale(chainId)
}

/**
 * Wei (`msg.value`, `eth_getBalance`) → quote units. Throws `INVALID_PARAMS` instead
 * of silently flooring when `wei` is not an exact multiple of the scale — a floored
 * value would understate what the pool actually received/owes. Use
 * `floorNativeValue` for the one legitimate lossy case.
 */
export function fromNativeValue(chainId: number, wei: bigint): bigint {
  const scale = getQuoteScale(chainId)
  const remainder = wei % scale
  if (remainder !== 0n) {
    throw new UnitsError(
      `wei value ${wei} is not an exact multiple of the chain ${chainId} scale ${scale} (remainder ${remainder})`,
      { chainId, wei, scale, remainder },
    )
  }
  return wei / scale
}

/**
 * Wei → quote units, floored. Mirrors the NativeERC20 Router's own
 * `_nativeIn() = msg.value / NATIVE_SCALE` arithmetic exactly. May ONLY be used to
 * reproduce that contract computation (e.g. previewing what the Router will treat as
 * the spendable input) — never to derive a bound such as `amountOutMin`, where the
 * caller must know whether dust was discarded.
 */
export function floorNativeValue(chainId: number, wei: bigint): bigint {
  return wei / getQuoteScale(chainId)
}

/** Throws `INVALID_PARAMS` unless `wei` is an exact multiple of the chain's scale. */
export function assertExactNativeMultiple(chainId: number, wei: bigint): void {
  fromNativeValue(chainId, wei)
}
