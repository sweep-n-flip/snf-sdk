/**
 * The Router's own curve and `RoyaltyHelper`, reproduced in `bigint` — byte for byte.
 *
 * `UniswapV2Library.getAmountOut`/`getAmountIn` (`snf-contracts/contracts/periphery/
 * libraries/UniswapV2Library.sol:94-116`) and `RoyaltyHelper.getRoyaltyInfo`
 * (`snf-contracts/contracts/periphery/libraries/RoyaltyHelper.sol`), ported from
 * `snf-drops-registration/src/features/mint-details/genesis/swap/swapQuoteMath.ts`
 * (the existing byte-exact BigInt reference) and extended with the multi-hop chain
 * helpers this SDK needs. There is no `number` arithmetic anywhere in this file except
 * array indices — R8's `===` reconciliation (`math/reconcile.ts`) only holds if this
 * reproduces the Solidity exactly.
 *
 * Native SnF NFT pools charge `SNF_NFT_NET_FEE` (2%) over `SNF_NFT_FEE_DENOM` — never
 * the plain-Uniswap-V2 0.3% pair constants. A delegated hop's `netFee` (a different,
 * chain-specific delegate constant on most chains) is a **per-hop parameter**, read
 * from the chain registry's `delegateNetFee` — it is never a literal in this file
 * (RESEARCH Assumption A2: each chain's own `Delegation.sol` sets its own value).
 */

/** Native SnF NFT pool fee numerator — `UniswapV2Library.sol`'s non-delegate branch
 * passes this as `netFee` (`UniswapV2Library.sol:125`, `getAmountsOut`'s `: 9800`). */
export const SNF_NFT_NET_FEE = 9800n
/** The fee denominator every `netFee` is scaled against (`UniswapV2Library.sol:102`). */
export const SNF_NFT_FEE_DENOM = 10000n
/** `1e18` — 100% in every royalty/marketplace-fee scale this module uses
 * (`RoyaltyHelper.sol`'s `100e16` literal is the same value spelled differently). */
export const ONE_E18 = 10n ** 18n

/**
 * `UniswapV2Library.getAmountOut` (`UniswapV2Library.sol:97-104`) — what comes OUT
 * for a given `amountIn`. The fee is taken from the input; there is no `+1` on this
 * side, the truncating division already rounds in the pool's favour. `undefined` on
 * any non-positive input or empty reserve — never a throw, never a zero.
 */
export function getAmountOut(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  netFee: bigint,
): bigint | undefined {
  if (amountIn <= 0n) return undefined
  if (reserveIn <= 0n || reserveOut <= 0n) return undefined
  const amountInWithFee = amountIn * netFee
  const numerator = amountInWithFee * reserveOut
  const denominator = reserveIn * SNF_NFT_FEE_DENOM + amountInWithFee
  return numerator / denominator
}

/**
 * `UniswapV2Library.getAmountIn` (`UniswapV2Library.sol:110-116`) — what must go IN
 * to take `amountOut` OUT, including the Router's own `+ 1` rounding-safety wei
 * (`UniswapV2Library.sol:115`) — that wei is already inside every answer the Router
 * gives, so it belongs here and nowhere else. `undefined` for a non-positive
 * `amountOut`, an empty reserve, or `amountOut >= reserveOut` (a pool never sells its
 * last unit — the constant product sends the price to infinity as the reserve empties).
 */
export function getAmountIn(
  amountOut: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  netFee: bigint,
): bigint | undefined {
  if (amountOut <= 0n) return undefined
  if (reserveIn <= 0n || reserveOut <= 0n) return undefined
  if (amountOut >= reserveOut) return undefined
  const numerator = reserveIn * amountOut * SNF_NFT_FEE_DENOM
  const denominator = (reserveOut - amountOut) * netFee
  return numerator / denominator + 1n
}

/**
 * `UniswapV2Library.getAmountsOut`'s per-hop chain (`UniswapV2Library.sol:119-127`) —
 * `reserves[i]` is `[reserveIn, reserveOut]` for hop `i`, `netFees[i]` is that hop's
 * own fee (an SnF hop uses `SNF_NFT_NET_FEE`, a delegate hop uses that chain's
 * `delegateNetFee` — the Router picks per-hop via `Factory.delegates`, this function
 * takes the already-resolved fee per hop instead). Returns the full `amounts[]`
 * (`amounts[0] === amountIn`), or `undefined` the moment any hop cannot be priced.
 */
export function getAmountsOutChain(
  amountIn: bigint,
  reserves: readonly (readonly [bigint, bigint])[],
  netFees: readonly bigint[],
): readonly bigint[] | undefined {
  if (reserves.length === 0 || reserves.length !== netFees.length) return undefined
  const amounts: bigint[] = [amountIn]
  for (let i = 0; i < reserves.length; i++) {
    const hop = reserves[i]
    const fee = netFees[i]
    const prev = amounts[amounts.length - 1]
    if (hop === undefined || fee === undefined || prev === undefined) return undefined
    const [reserveIn, reserveOut] = hop
    const out = getAmountOut(prev, reserveIn, reserveOut, fee)
    if (out === undefined) return undefined
    amounts.push(out)
  }
  return amounts
}

/**
 * `UniswapV2Library.getAmountsIn`'s per-hop chain (`UniswapV2Library.sol:130-138`) —
 * the mirror of `getAmountsOutChain`, walking the path backwards from a desired
 * `amountOut`. Returns the full `amounts[]` (`amounts[last] === amountOut`), or
 * `undefined` the moment any hop cannot be priced.
 */
export function getAmountsInChain(
  amountOut: bigint,
  reserves: readonly (readonly [bigint, bigint])[],
  netFees: readonly bigint[],
): readonly bigint[] | undefined {
  if (reserves.length === 0 || reserves.length !== netFees.length) return undefined
  const amounts: bigint[] = [amountOut]
  for (let i = reserves.length - 1; i >= 0; i--) {
    const hop = reserves[i]
    const fee = netFees[i]
    const next = amounts[0]
    if (hop === undefined || fee === undefined || next === undefined) return undefined
    const [reserveIn, reserveOut] = hop
    const inAmt = getAmountIn(next, reserveIn, reserveOut, fee)
    if (inAmt === undefined) return undefined
    amounts.unshift(inAmt)
  }
  return amounts
}

/** `total * feeE18 / 1e18` — the marketplace-fee row `RoyaltyHelper.sol` appends
 * (`:18` for the non-IERC2981 branch, `:51` for the IERC2981 branch). Exported
 * standalone because it is the ENTIRE calculation for a collection that doesn't
 * implement IERC2981 — a caller that already probed `supportsInterface` and got
 * `false` should call this directly instead of `reconstructRoyalty`, which assumes
 * the per-id branch (see that function's own header). Never subject to the cap. */
export function applyMarketplaceFee(total: bigint, feeE18: bigint): bigint {
  return (total * feeE18) / ONE_E18
}

/** One tokenId's EIP-2981 read, already resolved off-chain (`royaltyInfo`'s
 * `receiver`, and its rate at `1e18` scale — `5%` is `5n * 10n ** 16n`). One entry per
 * `tokenIds[i]`, same order. */
export interface RoyaltyLineInput {
  readonly receiver: `0x${string}`
  readonly royaltyE18: bigint
}

export interface ReconstructRoyaltyArgs {
  /** The pool-only leg (`amounts[0]` from `getAmountIn`/`getAmountOut`) — NEVER the
   * gross/net total. `RoyaltyHelper.sol`'s own `totalAmount` parameter. */
  readonly totalAmount: bigint
  readonly tokenIds: readonly string[]
  readonly perIdRoyalty: readonly RoyaltyLineInput[]
  /** The royalty cap at `1e18` scale. SPEC pins `capRoyaltyFee=false` in v1, which the
   * Router encodes by passing `cap = 100e16` ("no cap") — pass `ONE_E18` for that. The
   * branch below still implements the cap because `royaltyFeeCap` is read for display
   * (`effectiveBpsWhenCapped`), and a future v2 that flips the flag must not have to
   * rewrite this function. */
  readonly capE18: bigint
  /** `Router.marketplaceFee()`, live-read, at `1e18` scale. */
  readonly marketplaceFeeE18: bigint
}

export interface ReconstructRoyaltyResult {
  readonly perId: readonly bigint[]
  /** `royaltyTotal + marketplace` — matches `RoyaltyHelper.sol`'s own
   * `totalRoyaltyAmount` local, which already bundles both rows. */
  readonly total: bigint
  readonly capApplied: boolean
  readonly marketplace: bigint
  /** Sum of `perId` amounts whose receiver is the zero address — Arc's Router variant
   * drops these from what's charged on a buy / returns them to the seller on a sell
   * (`_unpayableRoyalties`, RESEARCH § "The Arc NativeERC20 variant"). `total` still
   * includes them, matching `RoyaltyHelper.sol` exactly — the Arc-specific adjustment
   * is a Router-variant concern for a later plan's `build/` module, not this one. */
  readonly unpayable: bigint
}

const ZERO_ADDRESS_RE = /^0x0+$/i

/**
 * `RoyaltyHelper.getRoyaltyInfo`'s IERC2981 branch (`RoyaltyHelper.sol:32-53`),
 * reproduced exactly:
 *   1. `salePrice = totalAmount / itemCount` is integer truncation, computed ONCE and
 *      reused for every per-id application (`RoyaltyHelper.sol:33`).
 *   2. Each `amount_i = salePrice * rate_i / 1e18` is applied PER ID, never as one
 *      multiplication over `totalAmount` (`RoyaltyHelper.sol:35`) — a flat-rate
 *      shortcut is algebraically valid ONLY when every id shares one rate; for a fresh
 *      quote always sum the true per-id reads (RESEARCH Pitfall 3).
 *   3. When the summed royalty exceeds `maxRoyaltyAmount = totalAmount * capE18 /
 *      1e18`, `scale = 1e18 * maxRoyaltyAmount / totalRoyaltyAmount` is integer, and
 *      every `amount_i` is re-floored through it (`RoyaltyHelper.sol:40-47`); the
 *      post-cap total is the SUM of the re-floored amounts, which can land up to
 *      `itemCount - 1` wei below `maxRoyaltyAmount` — two independent floors, not one.
 *   4. The marketplace row is appended AFTER the cap and is never scaled by it
 *      (`RoyaltyHelper.sol:50-53`).
 *
 * This function assumes the collection DOES implement IERC2981 (the caller already
 * probed `supportsInterface` — that network read lives in `collection/royalty.ts`,
 * not here). For a collection that does not, call `applyMarketplaceFee` directly.
 */
export function reconstructRoyalty(args: ReconstructRoyaltyArgs): ReconstructRoyaltyResult {
  const { totalAmount, tokenIds, perIdRoyalty, capE18, marketplaceFeeE18 } = args
  const marketplace = applyMarketplaceFee(totalAmount, marketplaceFeeE18)

  if (tokenIds.length === 0) {
    return { perId: [], total: marketplace, capApplied: false, marketplace, unpayable: 0n }
  }

  // RoyaltyHelper.sol:33 — integer truncation, computed once, reused for every id.
  const salePrice = totalAmount / BigInt(tokenIds.length)

  // RoyaltyHelper.sol:35 — royaltyInfo(tokenId, salePrice) applied PER ID.
  const rawRows = perIdRoyalty.map((line) => ({
    receiver: line.receiver,
    amount: (salePrice * line.royaltyE18) / ONE_E18,
  }))
  const rawSum = rawRows.reduce((acc, row) => acc + row.amount, 0n)

  // RoyaltyHelper.sol:40 — proportional cap, checked against the RAW (pre-cap) sum.
  const maxRoyaltyAmount = (totalAmount * capE18) / ONE_E18
  const capApplied = rawSum > maxRoyaltyAmount
  const scale = capApplied ? (rawSum === 0n ? 0n : (ONE_E18 * maxRoyaltyAmount) / rawSum) : ONE_E18
  // RoyaltyHelper.sol:43-47 — every amount_i re-floored through `scale`; the post-cap
  // total is the SUM of these, never `maxRoyaltyAmount` itself.
  const rows = capApplied
    ? rawRows.map((row) => ({ receiver: row.receiver, amount: (row.amount * scale) / ONE_E18 }))
    : rawRows

  const perId = rows.map((row) => row.amount)
  const royaltyTotal = perId.reduce((acc, amount) => acc + amount, 0n)
  const unpayable = rows.reduce(
    (acc, row) => acc + (ZERO_ADDRESS_RE.test(row.receiver) ? row.amount : 0n),
    0n,
  )

  // RoyaltyHelper.sol:50-53 — marketplace row appended AFTER the cap.
  return { perId, total: royaltyTotal + marketplace, capApplied, marketplace, unpayable }
}
