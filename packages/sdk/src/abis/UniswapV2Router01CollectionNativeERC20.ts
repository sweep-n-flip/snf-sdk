import { ROUTER02_COLLECTION_ABI } from './UniswapV2Router02Collection'

/**
 * Arc's Router variant ABI — `UniswapV2Router01CollectionNativeERC20`.
 *
 * There is no production-client TypeScript source for this ABI (Arc is the only chain
 * running it). Built directly from the deployed contract's Solidity source
 * (`UniswapV2Router01CollectionNativeERC20.sol`).
 *
 * This contract `is UniswapV2Router01Collection` — it OVERRIDES only the native-leg
 * functions (`addLiquidityETH*`, `removeLiquidityETH*`, `swap*ETH*`, all with the same
 * signatures as the standard Router) and ADDS exactly one new view: `NATIVE_SCALE()`.
 * Every other function (token/token, wrapper/token, ERC-20-quoted collection paths) is
 * inherited unchanged. So the full external ABI is `ROUTER02_COLLECTION_ABI` PLUS
 * `NATIVE_SCALE()` — no signature in the base set changes.
 *
 * On Arc (chainId 5042): the Router's `WETH()` (constructor `_quote`) returns the USDC
 * ERC-20 predeploy `0x3600000000000000000000000000000000000000` (6 decimals) — NOT a
 * WETH9 wrapper; it has no `deposit()`/`withdraw()`. Every pool-side amount
 * (`getReserves`, `getAmountsIn/OutCollection`, `amountETHMin`, returned `amountETH`) is
 * in that 6-decimal quote unit. Only `msg.value`, refunds and native payouts stay
 * 18-decimal wei. `NATIVE_SCALE = 10 ** (18 - quoteDecimals)` = `1_000_000_000_000`
 * (1e12) relates the two. There is no wUSDC anywhere in this system — the native
 * balance and the ERC-20 view are the SAME balance, just two interfaces over it. See
 * `docs/ARC_PRICING_DYNAMICS.md` and `chains/units.ts` (the one module allowed to do
 * this conversion).
 */
export const ROUTER_NATIVE_ERC20_ABI = [
  ...ROUTER02_COLLECTION_ABI,
  {
    inputs: [],
    name: 'NATIVE_SCALE',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const
