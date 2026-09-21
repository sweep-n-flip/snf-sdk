/**
 * D-03's core: every monetary value in the public API is this two-field shape — a
 * partner never has to know a token's decimals to use the SDK (54-CONTEXT.md D-03,
 * mirroring DATASHEET's `amount` + `formatted` convention).
 */

/**
 * An exact `bigint` paired with a display-only formatted string. `value` is what goes
 * into a transaction and what every internal computation uses; `formatted` is for UI
 * display ONLY and must NEVER be parsed back for math (DATASHEET §0.3: "Never parse
 * `formatted` for math"). `decimals` is this amount's own token decimals, so a caller
 * never has to look them up separately.
 */
export interface Amount {
  readonly value: bigint
  readonly formatted: string
  readonly symbol: string
  readonly decimals: number
}

/**
 * A token identity as the SDK expresses it. `address: null` means native (matching
 * DATASHEET §4's `payToken.address: null` for ETH/native-gas legs) — never a sentinel
 * address like `0x0` or `0xEeee…`.
 */
export interface TokenRef {
  readonly address: `0x${string}` | null
  readonly symbol: string
  readonly decimals: number
  readonly isNative: boolean
}
