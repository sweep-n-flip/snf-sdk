/**
 * Uniswap V2 Router02 (SnF Collection extension) ABI — verbatim copy.
 *
 * This file is a GENERATED DATA ARTIFACT, not hand-written logic: it is copied
 * byte-for-byte (only the exported const name changed) from
 * `snf-client/src/abis/UniswapV2Router02.ts` at commit `9e6c70aa466b62e68854cf781d723fd5cc08c1e8`
 * (snf-client HEAD `3863f69` at copy time). CLAUDE.md's "files should not exceed ~400
 * lines" rule targets hand-written logic that a maintainer edits line by line — an ABI
 * array has no such maintenance surface, so the line count is expected and acceptable
 * here (R21). Do not hand-trim entries to shrink it: `sideEffects: false` plus this
 * package's per-file exports already let a bundler drop an unimported ABI, and a
 * trimmed ABI is a silent wrong-decode risk against the real deployed bytecode.
 *
 * Router02 canonical cluster address (Ethereum/Arbitrum/Polygon/Apechain/Berachain/
 * Monad/Ronin/Avalanche/Robinhood/Arc): `0xDc0088a282d225f8cb08D092950Dde6eBAa36E78`.
 * Base, HyperEVM, Abstract and BNB Chain each deploy their own Router02 address — see
 * `chains/registry.ts`. Every one of them runs this same ABI (Arc's variant ADDS
 * `NATIVE_SCALE()` on top of it — see `UniswapV2Router01CollectionNativeERC20.ts`).
 *
 * Extends standard Uniswap V2 with NFT Collection functions:
 *   swapETHForExactTokensCollection     — buy specific NFTs with ETH
 *   swapExactTokensForETHCollection     — sell specific NFTs for ETH
 *   swapExactTokensForTokensCollection  — swap NFTs for tokens
 *   swapTokensForExactTokensCollection  — buy NFTs with tokens
 *   addLiquidityETHCollection           — add ETH + NFTs to pool
 *   addLiquidityCollection              — add token + NFTs to pool
 *   removeLiquidityETHCollection        — remove ETH + NFTs from pool (returns specific tokenIds + fractional wNFT)
 *   removeLiquidityCollection           — remove token + NFTs from pool
 *   getAmountsInCollection              — quote: ETH/token cost for exact NFT output
 *   getAmountsOutCollection             — quote: ETH/token output for exact NFT input
 *
 * All Collection functions take tokenIds[] directly; the Router handles
 * ERC-721 → WERC721 wrapping/unwrapping internally via Factory.getWrapper().
 * Callers must approve the Router via ERC-721.setApprovalForAll(router, true).
 * No manual WERC721 mint/burn or ERC-20 approve step is required.
 */
export const ROUTER02_COLLECTION_ABI = [
  // ── Constructor ───────────────────────────────────────────────────────────
  {
    inputs: [
      { internalType: 'address', name: '_factory',         type: 'address' },
      { internalType: 'address', name: '_WETH',            type: 'address' },
      { internalType: 'address', name: '_marketplaceAdmin', type: 'address' },
      { internalType: 'address', name: '_marketplaceWallet', type: 'address' },
      { internalType: 'uint256', name: '_marketplaceFee',  type: 'uint256' },
    ],
    stateMutability: 'nonpayable',
    type: 'constructor',
  },

  // ── Events ────────────────────────────────────────────────────────────────
  {
    anonymous: false,
    inputs: [{ indexed: false, internalType: 'address', name: 'marketplaceAdmin', type: 'address' }],
    name: 'UpdateAdmin',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: false, internalType: 'address', name: 'marketplaceWallet', type: 'address' },
      { indexed: false, internalType: 'uint256', name: 'marketplaceFee',    type: 'uint256' },
    ],
    name: 'UpdateFeeConfig',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true,  internalType: 'address', name: 'collection',    type: 'address' },
      { indexed: false, internalType: 'uint256', name: 'royaltyFeeCap', type: 'uint256' },
    ],
    name: 'UpdateRoyaltyFeeCap',
    type: 'event',
  },

  // ── Views ─────────────────────────────────────────────────────────────────
  {
    inputs: [],
    name: 'WETH',
    outputs: [{ internalType: 'address', name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'factory',
    outputs: [{ internalType: 'address', name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'marketplaceAdmin',
    outputs: [{ internalType: 'address', name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'marketplaceFee',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'marketplaceWallet',
    outputs: [{ internalType: 'address', name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: '', type: 'address' }],
    name: 'royaltyFeeCap',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },

  // ── AMM math helpers ──────────────────────────────────────────────────────
  {
    inputs: [
      { internalType: 'uint256', name: 'amountA',  type: 'uint256' },
      { internalType: 'uint256', name: 'reserveA', type: 'uint256' },
      { internalType: 'uint256', name: 'reserveB', type: 'uint256' },
    ],
    name: 'quote',
    outputs: [{ internalType: 'uint256', name: 'amountB', type: 'uint256' }],
    stateMutability: 'pure',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'uint256', name: 'amountIn',   type: 'uint256' },
      { internalType: 'uint256', name: 'reserveIn',  type: 'uint256' },
      { internalType: 'uint256', name: 'reserveOut', type: 'uint256' },
    ],
    name: 'getAmountOut',
    outputs: [{ internalType: 'uint256', name: 'amountOut', type: 'uint256' }],
    stateMutability: 'pure',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'uint256', name: 'amountOut',  type: 'uint256' },
      { internalType: 'uint256', name: 'reserveIn',  type: 'uint256' },
      { internalType: 'uint256', name: 'reserveOut', type: 'uint256' },
    ],
    name: 'getAmountIn',
    outputs: [{ internalType: 'uint256', name: 'amountIn', type: 'uint256' }],
    stateMutability: 'pure',
    type: 'function',
  },

  // ── Fungible quotes ───────────────────────────────────────────────────────
  {
    inputs: [
      { internalType: 'uint256',   name: 'amountIn', type: 'uint256' },
      { internalType: 'address[]', name: 'path',     type: 'address[]' },
    ],
    name: 'getAmountsOut',
    outputs: [{ internalType: 'uint256[]', name: 'amounts', type: 'uint256[]' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'uint256',   name: 'amountOut', type: 'uint256' },
      { internalType: 'address[]', name: 'path',      type: 'address[]' },
    ],
    name: 'getAmountsIn',
    outputs: [{ internalType: 'uint256[]', name: 'amounts', type: 'uint256[]' }],
    stateMutability: 'view',
    type: 'function',
  },

  // ── NFT Collection quotes ─────────────────────────────────────────────────

  /**
   * getAmountsOutCollection — quote ETH/token output for selling specific NFTs.
   * tokenIdsIn: NFT tokenIds being sold
   * path: [wrapperAddress, WETH] (or [..., tokenAddress])
   * capRoyaltyFee: whether to cap the royalty fee
   */
  {
    inputs: [
      { internalType: 'uint256[]', name: 'tokenIdsIn',    type: 'uint256[]' },
      { internalType: 'address[]', name: 'path',          type: 'address[]' },
      { internalType: 'bool',      name: 'capRoyaltyFee', type: 'bool' },
    ],
    name: 'getAmountsOutCollection',
    outputs: [{ internalType: 'uint256[]', name: 'amounts', type: 'uint256[]' }],
    stateMutability: 'view',
    type: 'function',
  },

  /**
   * getAmountsInCollection — quote ETH/token cost to buy specific NFTs.
   * tokenIdsOut: NFT tokenIds being purchased
   * path: [WETH, wrapperAddress] (or [tokenAddress, ...])
   * capRoyaltyFee: whether to cap the royalty fee
   */
  {
    inputs: [
      { internalType: 'uint256[]', name: 'tokenIdsOut',   type: 'uint256[]' },
      { internalType: 'address[]', name: 'path',          type: 'address[]' },
      { internalType: 'bool',      name: 'capRoyaltyFee', type: 'bool' },
    ],
    name: 'getAmountsInCollection',
    outputs: [{ internalType: 'uint256[]', name: 'amounts', type: 'uint256[]' }],
    stateMutability: 'view',
    type: 'function',
  },

  // ── Fungible swaps ────────────────────────────────────────────────────────
  {
    inputs: [
      { internalType: 'uint256',   name: 'amountOutMin', type: 'uint256' },
      { internalType: 'address[]', name: 'path',         type: 'address[]' },
      { internalType: 'address',   name: 'to',           type: 'address' },
      { internalType: 'uint256',   name: 'deadline',     type: 'uint256' },
    ],
    name: 'swapExactETHForTokens',
    outputs: [{ internalType: 'uint256[]', name: 'amounts', type: 'uint256[]' }],
    stateMutability: 'payable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'uint256',   name: 'amountOut',    type: 'uint256' },
      { internalType: 'address[]', name: 'path',         type: 'address[]' },
      { internalType: 'address',   name: 'to',           type: 'address' },
      { internalType: 'uint256',   name: 'deadline',     type: 'uint256' },
    ],
    name: 'swapETHForExactTokens',
    outputs: [{ internalType: 'uint256[]', name: 'amounts', type: 'uint256[]' }],
    stateMutability: 'payable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'uint256',   name: 'amountIn',     type: 'uint256' },
      { internalType: 'uint256',   name: 'amountOutMin', type: 'uint256' },
      { internalType: 'address[]', name: 'path',         type: 'address[]' },
      { internalType: 'address',   name: 'to',           type: 'address' },
      { internalType: 'uint256',   name: 'deadline',     type: 'uint256' },
    ],
    name: 'swapExactTokensForETH',
    outputs: [{ internalType: 'uint256[]', name: 'amounts', type: 'uint256[]' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'uint256',   name: 'amountOut',    type: 'uint256' },
      { internalType: 'uint256',   name: 'amountInMax',  type: 'uint256' },
      { internalType: 'address[]', name: 'path',         type: 'address[]' },
      { internalType: 'address',   name: 'to',           type: 'address' },
      { internalType: 'uint256',   name: 'deadline',     type: 'uint256' },
    ],
    name: 'swapTokensForExactETH',
    outputs: [{ internalType: 'uint256[]', name: 'amounts', type: 'uint256[]' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'uint256',   name: 'amountIn',     type: 'uint256' },
      { internalType: 'uint256',   name: 'amountOutMin', type: 'uint256' },
      { internalType: 'address[]', name: 'path',         type: 'address[]' },
      { internalType: 'address',   name: 'to',           type: 'address' },
      { internalType: 'uint256',   name: 'deadline',     type: 'uint256' },
    ],
    name: 'swapExactTokensForTokens',
    outputs: [{ internalType: 'uint256[]', name: 'amounts', type: 'uint256[]' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'uint256',   name: 'amountOut',    type: 'uint256' },
      { internalType: 'uint256',   name: 'amountInMax',  type: 'uint256' },
      { internalType: 'address[]', name: 'path',         type: 'address[]' },
      { internalType: 'address',   name: 'to',           type: 'address' },
      { internalType: 'uint256',   name: 'deadline',     type: 'uint256' },
    ],
    name: 'swapTokensForExactTokens',
    outputs: [{ internalType: 'uint256[]', name: 'amounts', type: 'uint256[]' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },

  // ── NFT Collection swaps ──────────────────────────────────────────────────

  /**
   * swapETHForExactTokensCollection — buy specific NFTs with ETH.
   * tokenIdsOut: exact NFT tokenIds to receive (specifies which NFTs from which collection)
   * path: [WETH, wrapperAddress] — WERC721 wrapper address in path
   * capRoyaltyFee: cap royalty to collection's configured max (false = pay full royalty)
   * msg.value: max ETH to spend (excess is refunded)
   * Caller does NOT need ERC-721 approval (no NFTs from caller).
   */
  {
    inputs: [
      { internalType: 'uint256[]', name: 'tokenIdsOut',   type: 'uint256[]' },
      { internalType: 'address[]', name: 'path',          type: 'address[]' },
      { internalType: 'bool',      name: 'capRoyaltyFee', type: 'bool' },
      { internalType: 'address',   name: 'to',            type: 'address' },
      { internalType: 'uint256',   name: 'deadline',      type: 'uint256' },
    ],
    name: 'swapETHForExactTokensCollection',
    outputs: [{ internalType: 'uint256[]', name: 'amounts', type: 'uint256[]' }],
    stateMutability: 'payable',
    type: 'function',
  },

  /**
   * swapExactTokensForETHCollection — sell specific NFTs for ETH.
   * tokenIdsIn: exact NFT tokenIds to sell (caller must own and have approved Router via setApprovalForAll)
   * amountOutMin: minimum ETH to receive (slippage protection)
   * path: [wrapperAddress, WETH]
   * capRoyaltyFee: cap royalty fee
   * Caller must: ERC-721.setApprovalForAll(router, true) before calling.
   */
  {
    inputs: [
      { internalType: 'uint256[]', name: 'tokenIdsIn',    type: 'uint256[]' },
      { internalType: 'uint256',   name: 'amountOutMin',  type: 'uint256' },
      { internalType: 'address[]', name: 'path',          type: 'address[]' },
      { internalType: 'bool',      name: 'capRoyaltyFee', type: 'bool' },
      { internalType: 'address',   name: 'to',            type: 'address' },
      { internalType: 'uint256',   name: 'deadline',      type: 'uint256' },
    ],
    name: 'swapExactTokensForETHCollection',
    outputs: [{ internalType: 'uint256[]', name: 'amounts', type: 'uint256[]' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },

  /**
   * swapExactTokensForTokensCollection — sell NFTs for ERC-20 tokens (multi-hop).
   * Caller must: ERC-721.setApprovalForAll(router, true).
   */
  {
    inputs: [
      { internalType: 'uint256[]', name: 'tokenIdsIn',    type: 'uint256[]' },
      { internalType: 'uint256',   name: 'amountOutMin',  type: 'uint256' },
      { internalType: 'address[]', name: 'path',          type: 'address[]' },
      { internalType: 'bool',      name: 'capRoyaltyFee', type: 'bool' },
      { internalType: 'address',   name: 'to',            type: 'address' },
      { internalType: 'uint256',   name: 'deadline',      type: 'uint256' },
    ],
    name: 'swapExactTokensForTokensCollection',
    outputs: [{ internalType: 'uint256[]', name: 'amounts', type: 'uint256[]' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },

  /**
   * swapTokensForExactTokensCollection — buy specific NFTs with ERC-20 tokens.
   * tokenIdsOut: exact NFT tokenIds to receive
   * amountInMax: max ERC-20 tokens to spend
   * path: [tokenAddress, wrapperAddress]
   */
  {
    inputs: [
      { internalType: 'uint256[]', name: 'tokenIdsOut',   type: 'uint256[]' },
      { internalType: 'uint256',   name: 'amountInMax',   type: 'uint256' },
      { internalType: 'address[]', name: 'path',          type: 'address[]' },
      { internalType: 'bool',      name: 'capRoyaltyFee', type: 'bool' },
      { internalType: 'address',   name: 'to',            type: 'address' },
      { internalType: 'uint256',   name: 'deadline',      type: 'uint256' },
    ],
    name: 'swapTokensForExactTokensCollection',
    outputs: [{ internalType: 'uint256[]', name: 'amounts', type: 'uint256[]' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },

  // ── Fungible liquidity ────────────────────────────────────────────────────
  {
    inputs: [
      { internalType: 'address', name: 'tokenA',        type: 'address' },
      { internalType: 'address', name: 'tokenB',        type: 'address' },
      { internalType: 'uint256', name: 'amountADesired', type: 'uint256' },
      { internalType: 'uint256', name: 'amountBDesired', type: 'uint256' },
      { internalType: 'uint256', name: 'amountAMin',    type: 'uint256' },
      { internalType: 'uint256', name: 'amountBMin',    type: 'uint256' },
      { internalType: 'address', name: 'to',            type: 'address' },
      { internalType: 'uint256', name: 'deadline',      type: 'uint256' },
    ],
    name: 'addLiquidity',
    outputs: [
      { internalType: 'uint256', name: 'amountA',    type: 'uint256' },
      { internalType: 'uint256', name: 'amountB',    type: 'uint256' },
      { internalType: 'uint256', name: 'liquidity',  type: 'uint256' },
    ],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: 'token',            type: 'address' },
      { internalType: 'uint256', name: 'amountTokenDesired', type: 'uint256' },
      { internalType: 'uint256', name: 'amountTokenMin',   type: 'uint256' },
      { internalType: 'uint256', name: 'amountETHMin',     type: 'uint256' },
      { internalType: 'address', name: 'to',               type: 'address' },
      { internalType: 'uint256', name: 'deadline',         type: 'uint256' },
    ],
    name: 'addLiquidityETH',
    outputs: [
      { internalType: 'uint256', name: 'amountToken', type: 'uint256' },
      { internalType: 'uint256', name: 'amountETH',   type: 'uint256' },
      { internalType: 'uint256', name: 'liquidity',   type: 'uint256' },
    ],
    stateMutability: 'payable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: 'tokenA',    type: 'address' },
      { internalType: 'address', name: 'tokenB',    type: 'address' },
      { internalType: 'uint256', name: 'liquidity', type: 'uint256' },
      { internalType: 'uint256', name: 'amountAMin', type: 'uint256' },
      { internalType: 'uint256', name: 'amountBMin', type: 'uint256' },
      { internalType: 'address', name: 'to',        type: 'address' },
      { internalType: 'uint256', name: 'deadline',  type: 'uint256' },
    ],
    name: 'removeLiquidity',
    outputs: [
      { internalType: 'uint256', name: 'amountA', type: 'uint256' },
      { internalType: 'uint256', name: 'amountB', type: 'uint256' },
    ],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: 'token',          type: 'address' },
      { internalType: 'uint256', name: 'liquidity',      type: 'uint256' },
      { internalType: 'uint256', name: 'amountTokenMin', type: 'uint256' },
      { internalType: 'uint256', name: 'amountETHMin',   type: 'uint256' },
      { internalType: 'address', name: 'to',             type: 'address' },
      { internalType: 'uint256', name: 'deadline',       type: 'uint256' },
    ],
    name: 'removeLiquidityETH',
    outputs: [
      { internalType: 'uint256', name: 'amountToken', type: 'uint256' },
      { internalType: 'uint256', name: 'amountETH',   type: 'uint256' },
    ],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: 'tokenA',    type: 'address' },
      { internalType: 'address', name: 'tokenB',    type: 'address' },
      { internalType: 'uint256', name: 'liquidity', type: 'uint256' },
      { internalType: 'uint256', name: 'amountAMin', type: 'uint256' },
      { internalType: 'uint256', name: 'amountBMin', type: 'uint256' },
      { internalType: 'address', name: 'to',        type: 'address' },
      { internalType: 'uint256', name: 'deadline',  type: 'uint256' },
      { internalType: 'bool',    name: 'approveMax', type: 'bool' },
      { internalType: 'uint8',   name: 'v',         type: 'uint8' },
      { internalType: 'bytes32', name: 'r',         type: 'bytes32' },
      { internalType: 'bytes32', name: 's',         type: 'bytes32' },
    ],
    name: 'removeLiquidityWithPermit',
    outputs: [
      { internalType: 'uint256', name: 'amountA', type: 'uint256' },
      { internalType: 'uint256', name: 'amountB', type: 'uint256' },
    ],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: 'token',          type: 'address' },
      { internalType: 'uint256', name: 'liquidity',      type: 'uint256' },
      { internalType: 'uint256', name: 'amountTokenMin', type: 'uint256' },
      { internalType: 'uint256', name: 'amountETHMin',   type: 'uint256' },
      { internalType: 'address', name: 'to',             type: 'address' },
      { internalType: 'uint256', name: 'deadline',       type: 'uint256' },
      { internalType: 'bool',    name: 'approveMax',     type: 'bool' },
      { internalType: 'uint8',   name: 'v',              type: 'uint8' },
      { internalType: 'bytes32', name: 'r',              type: 'bytes32' },
      { internalType: 'bytes32', name: 's',              type: 'bytes32' },
    ],
    name: 'removeLiquidityETHWithPermit',
    outputs: [
      { internalType: 'uint256', name: 'amountToken', type: 'uint256' },
      { internalType: 'uint256', name: 'amountETH',   type: 'uint256' },
    ],
    stateMutability: 'nonpayable',
    type: 'function',
  },

  // ── NFT Collection liquidity ──────────────────────────────────────────────

  /**
   * addLiquidityETHCollection — add ETH + specific NFTs to a pool.
   * collection: ERC-721 collection address (Router resolves wrapper via Factory)
   * tokenIds: specific NFT tokenIds to deposit (each NFT = 1e18 WERC721 units)
   * amountETHMin: minimum ETH to add (slippage protection; 0 for initial liquidity)
   * msg.value: ETH to deposit (Pool ratio + NFT count determines actual split)
   * Caller must: ERC-721.setApprovalForAll(router, true) before calling.
   */
  {
    inputs: [
      { internalType: 'address',   name: 'collection',   type: 'address' },
      { internalType: 'uint256[]', name: 'tokenIds',     type: 'uint256[]' },
      { internalType: 'uint256',   name: 'amountETHMin', type: 'uint256' },
      { internalType: 'address',   name: 'to',           type: 'address' },
      { internalType: 'uint256',   name: 'deadline',     type: 'uint256' },
    ],
    name: 'addLiquidityETHCollection',
    outputs: [
      { internalType: 'uint256', name: 'amountToken', type: 'uint256' },
      { internalType: 'uint256', name: 'amountETH',   type: 'uint256' },
      { internalType: 'uint256', name: 'liquidity',   type: 'uint256' },
    ],
    stateMutability: 'payable',
    type: 'function',
  },

  /**
   * addLiquidityCollection — add ERC-20 token + specific NFTs to a pool.
   * tokenA: ERC-20 token address
   * collectionB: ERC-721 collection address
   * amountADesired: desired token A amount
   * tokenIdsB: specific NFT tokenIds to deposit
   * amountAMin: minimum token A (slippage)
   * Caller must: ERC-721.setApprovalForAll(router, true) + tokenA.approve(router, amount).
   */
  {
    inputs: [
      { internalType: 'address',   name: 'tokenA',        type: 'address' },
      { internalType: 'address',   name: 'collectionB',   type: 'address' },
      { internalType: 'uint256',   name: 'amountADesired', type: 'uint256' },
      { internalType: 'uint256[]', name: 'tokenIdsB',     type: 'uint256[]' },
      { internalType: 'uint256',   name: 'amountAMin',    type: 'uint256' },
      { internalType: 'address',   name: 'to',            type: 'address' },
      { internalType: 'uint256',   name: 'deadline',      type: 'uint256' },
    ],
    name: 'addLiquidityCollection',
    outputs: [
      { internalType: 'uint256', name: 'amountA',   type: 'uint256' },
      { internalType: 'uint256', name: 'amountB',   type: 'uint256' },
      { internalType: 'uint256', name: 'liquidity', type: 'uint256' },
    ],
    stateMutability: 'nonpayable',
    type: 'function',
  },

  /**
   * removeLiquidityETHCollection — remove liquidity, receive ETH + specific NFTs + fractional wNFT.
   * collection: ERC-721 collection address
   * liquidity: LP token amount to burn
   * tokenIds: specific NFT tokenIds to redeem from the pool (pass [] to skip NFT redemption)
   * amountETHMin: minimum ETH to receive (slippage)
   * Returns: amountToken (wNFT fractional remainder), amountETH
   * LP token must be pre-approved: LP.approve(router, MAX_UINT256).
   */
  {
    inputs: [
      { internalType: 'address',   name: 'collection',   type: 'address' },
      { internalType: 'uint256',   name: 'liquidity',    type: 'uint256' },
      { internalType: 'uint256[]', name: 'tokenIds',     type: 'uint256[]' },
      { internalType: 'uint256',   name: 'amountETHMin', type: 'uint256' },
      { internalType: 'address',   name: 'to',           type: 'address' },
      { internalType: 'uint256',   name: 'deadline',     type: 'uint256' },
    ],
    name: 'removeLiquidityETHCollection',
    outputs: [
      { internalType: 'uint256', name: 'amountToken', type: 'uint256' },
      { internalType: 'uint256', name: 'amountETH',   type: 'uint256' },
    ],
    stateMutability: 'nonpayable',
    type: 'function',
  },

  /**
   * removeLiquidityCollection — remove liquidity, receive ERC-20 token + specific NFTs.
   * tokenA: ERC-20 token address
   * collectionB: ERC-721 collection address
   * tokenIdsB: specific NFT tokenIds to redeem
   * amountAMin: minimum token A to receive
   */
  {
    inputs: [
      { internalType: 'address',   name: 'tokenA',      type: 'address' },
      { internalType: 'address',   name: 'collectionB', type: 'address' },
      { internalType: 'uint256',   name: 'liquidity',   type: 'uint256' },
      { internalType: 'uint256[]', name: 'tokenIdsB',   type: 'uint256[]' },
      { internalType: 'uint256',   name: 'amountAMin',  type: 'uint256' },
      { internalType: 'address',   name: 'to',          type: 'address' },
      { internalType: 'uint256',   name: 'deadline',    type: 'uint256' },
    ],
    name: 'removeLiquidityCollection',
    outputs: [
      { internalType: 'uint256', name: 'amountA', type: 'uint256' },
      { internalType: 'uint256', name: 'amountB', type: 'uint256' },
    ],
    stateMutability: 'nonpayable',
    type: 'function',
  },

  // ── Admin ─────────────────────────────────────────────────────────────────
  {
    inputs: [{ internalType: 'address', name: '_marketplaceAdmin', type: 'address' }],
    name: 'updateAdmin',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: '_marketplaceWallet', type: 'address' },
      { internalType: 'uint256', name: '_marketplaceFee',    type: 'uint256' },
    ],
    name: 'updateFeeConfig',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: 'collection',      type: 'address' },
      { internalType: 'uint256', name: '_royaltyFeeCap',  type: 'uint256' },
    ],
    name: 'updateRoyaltyFeeCap',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },

  // ── Receive ───────────────────────────────────────────────────────────────
  { stateMutability: 'payable', type: 'receive' },
] as const
