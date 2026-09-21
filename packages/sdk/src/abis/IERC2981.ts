/**
 * EIP-2981 NFT Royalty Standard — minimal ABI. Verbatim copy from
 * `snf-client/src/abis/IERC2981.ts` (commit `efb8f4ebff495a4a45c8c9151dab437ea6bb0aa9`),
 * only the exported const renamed.
 *
 * https://eips.ethereum.org/EIPS/eip-2981
 *
 * Only exposes `royaltyInfo(tokenId, salePrice)` — the function that returns the
 * royalty receiver and the amount owed for a given sale price. Support is probed
 * first via ERC721_ABI's `supportsInterface(IERC2981_INTERFACE_ID)`.
 */
export const IERC2981_ABI = [
  {
    inputs: [
      { internalType: 'uint256', name: 'tokenId',   type: 'uint256' },
      { internalType: 'uint256', name: 'salePrice', type: 'uint256' },
    ],
    name: 'royaltyInfo',
    outputs: [
      { internalType: 'address', name: 'receiver',      type: 'address' },
      { internalType: 'uint256', name: 'royaltyAmount', type: 'uint256' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
] as const

/** bytes4(keccak256("royaltyInfo(uint256,uint256)")) — canonical EIP-2981 interface id. */
export const IERC2981_INTERFACE_ID = '0x2a55205a' as const
