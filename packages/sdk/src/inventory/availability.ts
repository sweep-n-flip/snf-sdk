import { assertParam } from '../errors'

/**
 * The two pure rules behind `poolInventory`: the buyable ceiling and
 * bigint id ordering. No I/O in this file — every input is already a `bigint`/string
 * array, and every comparison here stays `bigint` until the one documented, guarded
 * final narrowing to a plain `Number` at the very end of `availableCountFromReserve`.
 */

const DECIMAL_ID = /^\d+$/
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER)

/**
 * `max(0, floor(reserveWnft / 10**wrapperDecimals) − 1)` — a constant-product pool can
 * never sell its last unit (the curve asymptotes as the reserve approaches zero), so
 * the buyable ceiling is `floor(reserve) − 1`, never `floor(reserve)` (root
 * `CLAUDE.md`: "Teto comprável `floor(reserveWnft) − 1`"). The floor happens BEFORE
 * the minus one — `2e18 − 1` wei still floors to `1` whole unit, then `0` available,
 * never a negative-then-clamped `0`.
 *
 * `wrapperDecimals` is the NFT **wrapper's** own 18 (1 wrapped NFT = 1e18 WERC721
 * units) — a different axis from `chains/units.ts`'s `quoteDecimals` (6 on Arc, 18
 * elsewhere). Arc does not change this parameter; it stays 18 on every chain this
 * package supports.
 */
export function availableCountFromReserve(reserveWnft: bigint, wrapperDecimals = 18): number {
  const whole = reserveWnft / 10n ** BigInt(wrapperDecimals)
  const avail = whole > 0n ? whole - 1n : 0n
  assertParam(avail <= MAX_SAFE_BIGINT, 'availableCount exceeds Number.MAX_SAFE_INTEGER', {
    field: 'reserveWnft',
    value: reserveWnft.toString(),
  })
  return Number(avail)
}

/**
 * Deduplicates and sorts `ids` ascending **as bigint**, returning the original decimal
 * strings unchanged. Lexicographic sorting puts `'245830'` before `'76197'` — that is
 * the bug this function exists to prevent, which is why ids stay strings (a plain
 * `Number` conversion starts silently losing precision above `Number.MAX_SAFE_INTEGER`,
 * long before a real `uint256` tokenId would) but sort by their `bigint` value.
 * Rejects anything that is not a bare decimal string (hex, signs, empty) — a hex id
 * would silently sort wrong rather than fail loudly.
 */
export function normalizeTokenIds(ids: readonly string[]): readonly string[] {
  const byValue = new Map<bigint, string>()
  for (const id of ids) {
    assertParam(DECIMAL_ID.test(id), 'tokenId must be a decimal string (no hex, no sign)', {
      field: 'tokenId',
      value: id,
    })
    const value = BigInt(id)
    if (!byValue.has(value)) byValue.set(value, id)
  }
  return [...byValue.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, original]) => original)
}
