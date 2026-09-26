import { SnfError } from '../errors'

/**
 * `liquidityMath` — a pure, bigint-only mirror of the Router/Pair contract
 * arithmetic every liquidity quote and builder composes. No I/O, no `publicClient`,
 * no `number` arithmetic on amounts — the only bigint→number conversion in this file
 * is `wholeNfts`, which asserts the safe-integer bound before converting.
 *
 * Every function below names, in its own comment, the exact contract function it
 * mirrors and the rounding direction it reproduces. `test/liquidity/liquidityMath.
 * property.test.ts` proves the two rounding-direction claims against random
 * inputs rather than trusting a handful of examples.
 */

/** One wrapped NFT unit — `WERC721.decimals() === 18`. */
export const ONE_WNFT = 10n ** 18n

/** `UniswapV2Pair`'s permanently-locked first-mint liquidity (`mint` at
 * `totalSupply == 0` sends this amount to `address(0)`, never to the depositor). */
export const MINIMUM_LIQUIDITY = 1000n

/**
 * Mirrors `UniswapV2Library.quote(amountA, reserveA, reserveB)` — `pure`,
 * floor-rounded: `amountA * reserveB / reserveA`. Throws `INVALID_PARAMS` for the
 * same two `require`s the Library itself reverts on, so a caller of this pure
 * function sees the identical failure mode a Router call would.
 */
export function routerQuote(amountA: bigint, reserveA: bigint, reserveB: bigint): bigint {
  if (amountA <= 0n) {
    throw new SnfError('INVALID_PARAMS', 'UniswapV2Library: INSUFFICIENT_AMOUNT', {
      details: { field: 'amountA', value: amountA },
    })
  }
  if (reserveA <= 0n || reserveB <= 0n) {
    throw new SnfError('INVALID_PARAMS', 'UniswapV2Library: INSUFFICIENT_LIQUIDITY', {
      details: { field: 'reserves', reserveA, reserveB },
    })
  }
  return (amountA * reserveB) / reserveA
}

/**
 * The exact base amount the Router pulls for `nftCount` whole NFTs against live
 * reserves — `routerQuote(nftCount·1e18, reserveWnft, reserveBase)`, the same floor
 * division both `addLiquidityETHCollection`'s branch 1 (native) and
 * `addLiquidityCollection`'s branch 2 (ERC-20) actually settle on. This is the figure
 * an on-chain `Router.quote()` read must reconcile against to the wei (see
 * `math/reconcile.ts#reconcileExact`).
 */
export function requiredBase(nftCount: number, reserveWnft: bigint, reserveBase: bigint): bigint {
  return routerQuote(BigInt(nftCount) * ONE_WNFT, reserveWnft, reserveBase)
}

/**
 * The ERC-20-base `amountADesired` an add/seed into a priced pool must send:
 * `ceil((nftCount·1e18 + 1)·reserveBase/reserveWnft)`. Two traps sit on either side:
 * - the floor (`requiredBase`, `Router.quote`) reverts `INSUFFICIENT_B_AMOUNT` in
 *   `_addLiquidity`'s first branch whenever the division is not exact;
 * - the plain ceil lands in that same first branch whenever the rounded-back wNFT
 *   amount equals the deposit exactly, and then the Router pulls the CEIL — one wei
 *   more than `requiredBase`, which every quote, reconciliation and seed model uses.
 * The `+ 1` pushes the rounded-back wNFT amount strictly above the deposit, so the
 * Router always takes its second branch and pulls exactly `requiredBase`. The extra
 * is only the approved ceiling, never charged. The approval must cover this amount
 * (plus slippage). Proven by `liquidityMath.property.test.ts`.
 */
export function minErc20Desired(nftCount: number, reserveWnft: bigint, reserveBase: bigint): bigint {
  if (reserveWnft <= 0n) {
    throw new SnfError('INVALID_PARAMS', 'minErc20Desired requires a positive reserveWnft', {
      details: { field: 'reserveWnft', value: reserveWnft },
    })
  }
  const numerator = (BigInt(nftCount) * ONE_WNFT + 1n) * reserveBase
  return (numerator + reserveWnft - 1n) / reserveWnft
}

export interface AddLiquidityAmountsArgs {
  readonly amountADesired: bigint
  readonly amountBDesired: bigint
  readonly amountAMin: bigint
  readonly amountBMin: bigint
  readonly reserveA: bigint
  readonly reserveB: bigint
}

export type AddLiquidityAmountsResult =
  | { readonly ok: true; readonly amountA: bigint; readonly amountB: bigint }
  | { readonly ok: false; readonly revert: 'INSUFFICIENT_A_AMOUNT' | 'INSUFFICIENT_B_AMOUNT' }

/**
 * Mirrors `UniswapV2Router01._addLiquidity` exactly, branch for branch. When
 * both reserves are zero (the pair does not exist yet, or exists empty) the desired
 * amounts are returned UNTOUCHED and the minimums are NEVER read — this is the exact
 * contract behaviour that makes a zero/loose minimum on a pool-creating deposit a
 * same-block front-run window (S6a); a create/seed build must therefore pass EXACT
 * minimums (min = the intended amount), never zero.
 */
export function addLiquidityAmounts(args: AddLiquidityAmountsArgs): AddLiquidityAmountsResult {
  const { amountADesired, amountBDesired, amountAMin, amountBMin, reserveA, reserveB } = args

  if (reserveA === 0n && reserveB === 0n) {
    return { ok: true, amountA: amountADesired, amountB: amountBDesired }
  }

  const amountBOptimal = routerQuote(amountADesired, reserveA, reserveB)
  if (amountBOptimal <= amountBDesired) {
    if (amountBOptimal < amountBMin) {
      return { ok: false, revert: 'INSUFFICIENT_B_AMOUNT' }
    }
    return { ok: true, amountA: amountADesired, amountB: amountBOptimal }
  }

  const amountAOptimal = routerQuote(amountBDesired, reserveB, reserveA)
  if (amountAOptimal > amountADesired) {
    // Mirrors the Router's own bare `assert(amountAOptimal <= amountADesired)` —
    // an internal invariant that only fails on a pathological reserve/desired
    // combination the branch-1 condition above should already have excluded.
    // On-chain this is a Panic(0x01), never a revert-string; UNKNOWN carries the
    // same "should never happen" meaning here.
    throw new SnfError('UNKNOWN', 'internal: amountAOptimal exceeded amountADesired', {
      details: { amountAOptimal, amountADesired },
    })
  }
  if (amountAOptimal < amountAMin) {
    return { ok: false, revert: 'INSUFFICIENT_A_AMOUNT' }
  }
  return { ok: true, amountA: amountAOptimal, amountB: amountBDesired }
}

/**
 * Mirrors `UniswapV2Pair`'s internal `Math.sqrt` (Babylonian method) — the exact
 * integer floor of `sqrt(x)`, matching the contract's own `y > 3` Newton-iteration
 * branch and its `y in {1,2,3} -> 1` / `y === 0 -> 0` special cases bit-for-bit.
 */
export function floorSqrt(x: bigint): bigint {
  if (x < 0n) {
    throw new SnfError('INVALID_PARAMS', 'floorSqrt requires a non-negative input', {
      details: { field: 'x', value: x },
    })
  }
  if (x <= 3n) {
    return x === 0n ? 0n : 1n
  }
  let z = x
  let y = x / 2n + 1n
  while (y < z) {
    z = y
    y = (x / y + y) / 2n
  }
  return z
}

export interface MintLiquidityArgs {
  readonly amount0: bigint
  readonly amount1: bigint
  readonly reserve0: bigint
  readonly reserve1: bigint
  readonly totalSupply: bigint
}

/**
 * Mirrors `UniswapV2Pair.mint`'s liquidity computation (fee-off, i.e.
 * `Factory.feeTo() == 0` — the only circumstance a liquidity quote is ever constructed under,
 * see `LiquidityQuoteDetails.feeToZero`). First deposit: `floorSqrt(amount0 *
 * amount1) - MINIMUM_LIQUIDITY` (the 1000-unit lock to `address(0)`). Subsequent
 * deposits: `min(amount0 * totalSupply / reserve0, amount1 * totalSupply /
 * reserve1)`, both floor-divided. A result `<= 0n` means the real `Pair.mint` call
 * would revert `INSUFFICIENT_LIQUIDITY_MINTED` — this function returns that
 * (possibly non-positive) value rather than throwing, so a caller can decide how to
 * surface it.
 */
export function mintLiquidity(args: MintLiquidityArgs): bigint {
  const { amount0, amount1, reserve0, reserve1, totalSupply } = args
  if (totalSupply === 0n) {
    return floorSqrt(amount0 * amount1) - MINIMUM_LIQUIDITY
  }
  const liquidity0 = (amount0 * totalSupply) / reserve0
  const liquidity1 = (amount1 * totalSupply) / reserve1
  return liquidity0 < liquidity1 ? liquidity0 : liquidity1
}

export interface BurnAmountsArgs {
  readonly liquidity: bigint
  readonly balance0: bigint
  readonly balance1: bigint
  readonly totalSupply: bigint
}

export interface BurnAmountsResult {
  readonly amount0: bigint
  readonly amount1: bigint
}

/**
 * Mirrors `UniswapV2Pair.burn`'s payout computation — `liquidity * balanceX /
 * totalSupply`, floor-divided, using the pair's OWN token balances (never the
 * `getReserves` cache): `Pair.burn` pays out of `balanceOf(address(this))`, which can
 * differ from the last-synced reserves. The discrete/wNFT rounding branch present in
 * older Pair generations is commented out on the Latest Pair — this is pure pro-rata,
 * nothing else.
 */
export function burnAmounts(args: BurnAmountsArgs): BurnAmountsResult {
  const { liquidity, balance0, balance1, totalSupply } = args
  return {
    amount0: (liquidity * balance0) / totalSupply,
    amount1: (liquidity * balance1) / totalSupply,
  }
}

/**
 * Floors a wNFT amount down to a whole-NFT count. The only bigint→number conversion
 * in this file — asserts the safe-integer bound first, since a pool could in
 * principle (never in practice) hold more wrapped units than `Number` can represent
 * exactly.
 */
export function wholeNfts(wnftAmount: bigint): number {
  const whole = wnftAmount / ONE_WNFT
  if (whole > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new SnfError('UNKNOWN', 'wholeNfts: whole-unit count exceeds Number.MAX_SAFE_INTEGER', {
      details: { wnftAmount },
    })
  }
  return Number(whole)
}

export interface PairOrderValue {
  readonly base: bigint
  readonly wnft: bigint
}

export interface PairSlotValue {
  readonly v0: bigint
  readonly v1: bigint
}

/** Maps a `{ base, wnft }` pair into `{ v0, v1 }` pair-slot order — never assume the
 * wrapper is `token1` (root `CLAUDE.md`, "What NOT to Do"). */
export function toPairOrder(wrapperIsToken0: boolean, v: PairOrderValue): PairSlotValue {
  return wrapperIsToken0 ? { v0: v.wnft, v1: v.base } : { v0: v.base, v1: v.wnft }
}

/** The inverse of `toPairOrder` — maps `{ v0, v1 }` pair-slot order back to `{ base,
 * wnft }`. */
export function fromPairOrder(wrapperIsToken0: boolean, v: PairSlotValue): PairOrderValue {
  return wrapperIsToken0 ? { base: v.v1, wnft: v.v0 } : { base: v.v0, wnft: v.v1 }
}
