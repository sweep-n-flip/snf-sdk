/**
 * ERC-721 ABI covering ownership, approval and ERC165 detection. Verbatim copy from
 * the production AMM client's own ABI, only the exported const renamed. Includes
 * ERC721Enumerable's `tokenOfOwnerByIndex` for NFT ownership fallback and ERC165's
 * `supportsInterface` for pool-type detection.
 *
 * `tokenURI` added later (missing
 * critical functionality): the production client's own copy doesn't need it (that app
 * reads `tokenURI` through a separate ad-hoc minimal ABI elsewhere), but
 * `providers/onChainImages.ts`'s keyless
 * default images provider (ERC721Metadata `tokenURI`) is the reason this ABI
 * exists in this package at all, and the documented requirement text ("`publicClient.multicall({
 * ... abi: ERC721_ABI, functionName: 'tokenURI' ...})`") names this exact ABI as the
 * one to call it through — a stub with no `tokenURI` function cannot satisfy that.
 *
 * ERC-721 interface ID: 0x80ac58cd
 */
export const ERC721_ABI = [
  {
    inputs: [{ name: 'owner', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    name: 'tokenURI',
    outputs: [{ name: '', type: 'string' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    name: 'ownerOf',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { name: 'owner',    type: 'address' },
      { name: 'operator', type: 'address' },
    ],
    name: 'isApprovedForAll',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { name: 'operator', type: 'address' },
      { name: 'approved', type: 'bool' },
    ],
    name: 'setApprovalForAll',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'index', type: 'uint256' },
    ],
    name: 'tokenOfOwnerByIndex',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    // ERC165: used for NFT pool detection (try/catch required — not all contracts implement)
    inputs: [{ name: 'interfaceId', type: 'bytes4' }],
    name: 'supportsInterface',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: 'from',    type: 'address' },
      { indexed: true, name: 'to',      type: 'address' },
      { indexed: true, name: 'tokenId', type: 'uint256' },
    ],
    name: 'Transfer',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: 'owner',    type: 'address' },
      { indexed: true, name: 'approved', type: 'address' },
      { indexed: true, name: 'tokenId',  type: 'uint256' },
    ],
    name: 'Approval',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: 'owner',    type: 'address' },
      { indexed: true, name: 'operator', type: 'address' },
      { indexed: false, name: 'approved', type: 'bool' },
    ],
    name: 'ApprovalForAll',
    type: 'event',
  },
] as const
