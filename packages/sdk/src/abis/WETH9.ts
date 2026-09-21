/**
 * Minimal ABI for the WETH9-style wrapped native token contract. Verbatim copy from
 * `snf-client/src/abis/WETH9.ts` (commit `8033576215687c00b38bb8c5b7a8635cf959122c`),
 * only the exported const renamed, PLUS the `Withdrawal`/`Deposit` events (added in
 * plan 08 — the original `snf-client` copy has only the two functions; `receipt/
 * parseReceipt.ts` (R16) needs the events to attribute the native leg of a settled
 * buy/sell from a mined receipt's logs, and neither event's shape is delegate- or
 * chain-specific, so adding them here is a superset, never a divergence from the
 * verbatim function copy above).
 *
 * Every chain's wrapped native (WETH/WMATIC/WMON/WAPE/WBERA/WHYPE/WRON/WAVAX) implements
 * the same two functions and the same two events:
 *   - deposit() payable    → wraps msg.value into wrapped-token ERC-20 balance, emits Deposit(dst, wad)
 *   - withdraw(uint256)    → burns wrapped-token balance, sends native back, emits Withdrawal(src, wad)
 *
 * NOT applicable to Arc — its quote token is the USDC ERC-20 predeploy, which has
 * neither function nor these events. See `UniswapV2Router01CollectionNativeERC20.ts`.
 */
export const WETH9_ABI = [
  {
    type: 'function',
    name: 'deposit',
    stateMutability: 'payable',
    inputs: [],
    outputs: [],
  },
  {
    type: 'function',
    name: 'withdraw',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'wad', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'event',
    anonymous: false,
    name: 'Deposit',
    inputs: [
      { indexed: true, name: 'dst', type: 'address' },
      { indexed: false, name: 'wad', type: 'uint256' },
    ],
  },
  {
    type: 'event',
    anonymous: false,
    name: 'Withdrawal',
    inputs: [
      { indexed: true, name: 'src', type: 'address' },
      { indexed: false, name: 'wad', type: 'uint256' },
    ],
  },
] as const
