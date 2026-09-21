/**
 * Uniswap V2 Factory (SnF extension) ABI — verbatim copy from
 * `snf-client/src/abis/UniswapV2Factory.ts` (commit `9e6c70aa466b62e68854cf781d723fd5cc08c1e8`),
 * only the exported const renamed. See `UniswapV2Router02Collection.ts` for the R21
 * "generated data artifact" note on why this file is not subject to the ~400-line rule.
 *
 * Sweep n' Flip extensions over standard Uniswap V2:
 *   createWrapper(collection)  — deploy WERC721 ERC-20 wrapper for an ERC-721 collection
 *   getWrapper(collection)     — returns WERC721 wrapper address (address(0) if not deployed)
 *   getCollection(wrapper)     — reverse lookup: wrapper → ERC-721 collection address
 *   allWrappers(index)         — enumerate deployed wrappers by index
 *   allWrappersLength()        — count of all deployed wrappers
 *   delegates(token0, token1)  — whether pair delegates NFT handling
 *   router(router)             — whether a router address is authorized
 *   WrapperCreated event       — emitted on new WERC721 wrapper deployment
 */
export const FACTORY_ABI = [
  // ── Constructor ───────────────────────────────────────────────────────────
  {
    inputs: [
      { internalType: 'address', name: '_feeToSetter',    type: 'address' },
      { internalType: 'address', name: '_routerSetter',   type: 'address' },
    ],
    stateMutability: 'nonpayable',
    type: 'constructor',
  },

  // ── Events ────────────────────────────────────────────────────────────────
  {
    anonymous: false,
    inputs: [
      { indexed: true,  internalType: 'address', name: 'token0', type: 'address' },
      { indexed: true,  internalType: 'address', name: 'token1', type: 'address' },
      { indexed: false, internalType: 'address', name: 'pair',   type: 'address' },
      { indexed: false, internalType: 'uint256', name: '',       type: 'uint256' },
    ],
    name: 'PairCreated',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true,  internalType: 'address', name: 'collection', type: 'address' },
      { indexed: false, internalType: 'address', name: 'wrapper',    type: 'address' },
      { indexed: false, internalType: 'uint256', name: '',           type: 'uint256' },
    ],
    name: 'WrapperCreated',
    type: 'event',
  },

  // ── Views ─────────────────────────────────────────────────────────────────
  {
    inputs: [],
    name: '_initCodeHash',
    outputs: [{ internalType: 'bytes32', name: '', type: 'bytes32' }],
    stateMutability: 'pure',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    name: 'allPairs',
    outputs: [{ internalType: 'address', name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'allPairsLength',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    name: 'allWrappers',
    outputs: [{ internalType: 'address', name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'allWrappersLength',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: '', type: 'address' },
      { internalType: 'address', name: '', type: 'address' },
    ],
    name: 'delegates',
    outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'feeTo',
    outputs: [{ internalType: 'address', name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'feeToSetter',
    outputs: [{ internalType: 'address', name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: '', type: 'address' }],
    name: 'getCollection',
    outputs: [{ internalType: 'address', name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: '', type: 'address' },
      { internalType: 'address', name: '', type: 'address' },
    ],
    name: 'getPair',
    outputs: [{ internalType: 'address', name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: '', type: 'address' }],
    name: 'getWrapper',
    outputs: [{ internalType: 'address', name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: '', type: 'address' }],
    name: 'router',
    outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'routerSetter',
    outputs: [{ internalType: 'address', name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },

  // ── Writes ────────────────────────────────────────────────────────────────

  /**
   * createPair — deploy a new Uniswap V2 pair for two ERC-20 tokens.
   * For NFT pools, pass (WETH, wrapperAddress). Called automatically by
   * addLiquidityETHCollection on first liquidity add if pair doesn't exist.
   */
  {
    inputs: [
      { internalType: 'address', name: 'tokenA', type: 'address' },
      { internalType: 'address', name: 'tokenB', type: 'address' },
    ],
    name: 'createPair',
    outputs: [{ internalType: 'address', name: 'pair', type: 'address' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },

  /**
   * createWrapper — deploy a WERC721 ERC-20 wrapper for an ERC-721 collection.
   * Reverts if wrapper already exists — caller must check getWrapper() returns address(0) first.
   * Emits WrapperCreated(indexed collection, wrapper, uint256).
   */
  {
    inputs: [{ internalType: 'address', name: 'collection', type: 'address' }],
    name: 'createWrapper',
    outputs: [{ internalType: 'address', name: 'wrapper', type: 'address' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },

  {
    inputs: [{ internalType: 'address', name: '_feeTo', type: 'address' }],
    name: 'setFeeTo',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: '_feeToSetter', type: 'address' }],
    name: 'setFeeToSetter',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: '_router',  type: 'address' },
      { internalType: 'bool',    name: '_enabled', type: 'bool' },
    ],
    name: 'setRouter',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: '_routerSetter', type: 'address' }],
    name: 'setRouterSetter',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const
