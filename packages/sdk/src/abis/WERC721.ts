/**
 * WERC721 — Wrapped ERC-721 ABI (Sweep n' Flip protocol). Verbatim copy from
 * the production AMM client's own ABI.
 *
 * Each WERC721 contract wraps a single ERC-721 collection into an ERC-20
 * compatible token. One wrapped NFT = 1 * 10^18 WERC721 units (decimals = 18).
 *
 * Confirmed from IPFS manifest QmQ28JfS4jqSdqijeXZarQjnjc6rhpXrNrrz6UMah3NAnk
 * ABI CID: QmcBFmmYQyz7qj68DCxJ8448BCgaGg9CmvnZdJa2Bt4yKt
 *
 * Key operations:
 * mint(to, tokenIds[]) — transfer NFTs in, receive ERC-20 units
 * burn(to, tokenIds[]) — burn ERC-20 units, receive specific NFTs out
 * collection() — returns the underlying ERC-721 contract address
 * factory() — returns the SnF Factory that created this wrapper
 */
export const WERC721_ABI = [
  // ── Events ───────────────────────────────────────────────────────────────────

  {
    anonymous: false,
    inputs: [
      { indexed: true,  name: 'owner',   type: 'address' },
      { indexed: true,  name: 'spender', type: 'address' },
      { indexed: false, name: 'value',   type: 'uint256' },
    ],
    name: 'Approval',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true,  name: 'from',     type: 'address' },
      { indexed: true,  name: 'to',       type: 'address' },
      { indexed: false, name: 'tokenIds', type: 'uint256[]' },
    ],
    name: 'Burn',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true,  name: 'from',     type: 'address' },
      { indexed: true,  name: 'to',       type: 'address' },
      { indexed: false, name: 'tokenIds', type: 'uint256[]' },
    ],
    name: 'Mint',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true,  name: 'from',  type: 'address' },
      { indexed: true,  name: 'to',    type: 'address' },
      { indexed: false, name: 'value', type: 'uint256' },
    ],
    name: 'Transfer',
    type: 'event',
  },

  // ── ERC-20 view ───────────────────────────────────────────────────────────

  {
    inputs: [
      { name: 'owner',   type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    name: 'allowance',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'owner', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'decimals',
    outputs: [{ name: '', type: 'uint8' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'name',
    outputs: [{ name: '', type: 'string' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'symbol',
    outputs: [{ name: '', type: 'string' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'totalSupply',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },

  // ── Wrapper-specific view ─────────────────────────────────────────────────

  {
    inputs: [],
    name: 'collection',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'factory',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },

  // ── ERC-20 write ──────────────────────────────────────────────────────────

  {
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'value',   type: 'uint256' },
    ],
    name: 'approve',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { name: 'to',    type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    name: 'transfer',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { name: 'from',  type: 'address' },
      { name: 'to',    type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    name: 'transferFrom',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },

  // ── NFT wrap / unwrap ─────────────────────────────────────────────────────

  /**
   * mint(to, tokenIds) — wraps NFTs into ERC-20 units.
   * Caller must have ERC-721 approval (setApprovalForAll) on the collection
   * before calling this. Each tokenId in the array is transferred from the
   * caller to this contract; caller receives 1 * 10^18 WERC721 per NFT.
   */
  {
    inputs: [
      { name: 'to',       type: 'address' },
      { name: 'tokenIds', type: 'uint256[]' },
    ],
    name: 'mint',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },

  /**
   * burn(to, tokenIds) — unwraps specific NFTs from this contract.
   * Caller burns 1 * 10^18 WERC721 per NFT and receives the specified
   * tokenIds. The tokenIds must currently be held by this contract.
   */
  {
    inputs: [
      { name: 'to',       type: 'address' },
      { name: 'tokenIds', type: 'uint256[]' },
    ],
    name: 'burn',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },

  /**
   * initialize(collection) — called by the Factory once on deployment.
   * Not callable externally after initialization.
   */
  {
    inputs: [{ name: '', type: 'address' }],
    name: 'initialize',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const
