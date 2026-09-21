/**
 * Type definitions for the SDK's chain registry (R2, R21; 54-SPEC.md).
 *
 * See `registry.ts` for the 14-chain, latest-only data this shape describes, and
 * `units.ts` for the two-unit-axes conversions that consume `quoteDecimals`.
 */

/**
 * Router bytecode family. `'native-erc20'` is Arc's
 * `UniswapV2Router01CollectionNativeERC20` variant, whose `WETH()` returns an ERC-20
 * view of the native balance (the USDC predeploy) instead of a WETH9 wrapper — see
 * `abis/UniswapV2Router01CollectionNativeERC20.ts`. Every other chain runs the
 * standard `UniswapV2Router02Collection` ABI.
 */
export type RouterVariant = 'standard' | 'native-erc20'

/**
 * The 14 chainIds the SDK supports, latest-only — same membership `snf-client`'s
 * `supportedChains` ships. A future 15th chain (or a Legacy re-entry) is a SPEC
 * amendment, never a runtime toggle: no function in `chains/` accepts a `mode`
 * parameter, and `getChain` on anything outside this union is `INVALID_PARAMS`.
 */
export type SnfChainId =
  | 4663 // Robinhood Chain
  | 1 // Ethereum
  | 8453 // Base
  | 42161 // Arbitrum
  | 137 // Polygon
  | 999 // HyperEVM
  | 33139 // Apechain
  | 80094 // Berachain
  | 143 // Monad
  | 2741 // Abstract
  | 2020 // Ronin
  | 43114 // Avalanche
  | 56 // BNB Chain
  | 5042 // Arc

/**
 * Full configuration for one supported chain. Every field is spelled out explicitly
 * on every entry in `registry.ts` — no optional field defaults silently, because a
 * silently-defaulted address or decimals count is exactly the class of bug R2 and
 * R11 exist to prevent.
 */
export interface SnfChainConfig {
  chainId: SnfChainId
  name: string
  shortName: string
  nativeSymbol: string
  /** Decimals of the chain's native gas asset as seen by `tx.value`/`eth_getBalance`. Always 18. */
  nativeDecimals: number
  factory: `0x${string}`
  router02: `0x${string}`
  routerVariant: RouterVariant
  /**
   * The Router's `WETH()` address — the pool's quote token. On 13 chains this is a
   * WETH9-style wrapper; on Arc it is the USDC ERC-20 predeploy, not a wrapper.
   */
  quoteToken: `0x${string}`
  /** Decimals of `quoteToken`. 18 on every WETH9 chain, 6 on Arc. */
  quoteDecimals: number
  /** False when `quoteToken` has no `deposit()`/`withdraw()` (Arc only). */
  hasNativeWrapper: boolean
  multicall3: `0x${string}`
  subgraphUrl: string
  explorerUrl: string
  /**
   * `DELEGATE_NET_FEE` out of 10000 from this chain's own `Delegation.sol` /
   * `scripts/delegate-configs.ts` entry — verified per chain, not assumed to be a
   * single global constant (RESEARCH Assumption A2). See `registry.ts` for the
   * per-chain source of each value.
   */
  delegateNetFee: number
  /** Native SnF NFT pool fee out of 10000. Always 9800 (`UniswapV2Library.sol` constant). */
  poolNetFee: number
  /**
   * A public, keyless RPC endpoint. Never the workspace's Alchemy-keyed template — a
   * partner supplies their own `PublicClient`; this field exists only for the
   * repo's own fork lanes and examples.
   */
  defaultRpcUrl: string
}
