/**
 * Minimal ABI for the WETH9-style wrapped native token contract. Verbatim copy from
 * `snf-client/src/abis/WETH9.ts` (commit `8033576215687c00b38bb8c5b7a8635cf959122c`),
 * only the exported const renamed.
 *
 * Every chain's wrapped native (WETH/WMATIC/WMON/WAPE/WBERA/WHYPE/WRON/WAVAX) implements
 * the same two functions:
 *   - deposit() payable    → wraps msg.value into wrapped-token ERC-20 balance
 *   - withdraw(uint256)    → burns wrapped-token balance, sends native back
 *
 * NOT applicable to Arc — its quote token is the USDC ERC-20 predeploy, which has
 * neither function. See `UniswapV2Router01CollectionNativeERC20.ts`.
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
] as const
