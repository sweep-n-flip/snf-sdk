/**
 * `appLinks` argument types. See `src/appLinks.ts` for the builders themselves and for
 * why every URL carries `chain={chainId}` and never touches a backend endpoint.
 */

/** Overrides the default app origin. `origin` must be a bare `https:` origin — no
 * path, query, hash or credentials — or the builder throws `INVALID_PARAMS` naming
 * `details.field === 'origin'`. Omitted, it defaults to the public SnF app. */
export interface AppLinkOptions {
  readonly origin?: string
}

/** A swap-side token reference for an app link: an ERC-20/wrapper address, or the
 * literal `'native'`, which the app resolves to each chain's own native asset (USDC on
 * Arc, ETH/the chain's native gas token elsewhere). */
export type AppLinkToken = `0x${string}` | 'native'

/** Deep-links `/liquidity?tab=add` or `?tab=remove` for one existing pool. */
export interface AppLiquidityPoolLink {
  readonly tab: 'add' | 'remove'
  readonly pair: `0x${string}`
}

/** Deep-links `/liquidity?tab=create`, prefilled with the collection to pool. */
export interface AppLiquidityCreateLink {
  readonly tab: 'create'
  readonly collection: `0x${string}`
}

export type AppLiquidityLinkArgs = AppLiquidityPoolLink | AppLiquidityCreateLink

/** Optional preselected swap sides. An omitted side is omitted from the URL entirely
 * (the app falls back to its own default for that side), never emitted empty. */
export interface AppSwapLinkArgs {
  readonly tokenIn?: AppLinkToken
  readonly tokenOut?: AppLinkToken
}
