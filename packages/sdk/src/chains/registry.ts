import { SnfError } from '../errors'
import type { SnfChainConfig, SnfChainId } from './chains.types'

/**
 * The SDK's single source of truth for chains and contracts (R2; 54-SPEC.md).
 *
 * TWO UNIT AXES (read this before touching an amount)
 * ----------------------------------------------------
 * Every SnF pool pairs the NFT wrapper with the chain's "WETH" slot (the Router's
 * `WETH()` address, this file's `quoteToken`). On 13 chains that slot is a WETH9-style
 * wrapper with 18 decimals, so one wei of `msg.value` equals one raw pool-side unit and
 * amounts can be treated as a single number.
 *
 * Arc (chainId 5042) breaks that: USDC is the native gas token, `msg.value` stays
 * 18-decimal, and the pool's quote token is the USDC ERC-20 predeploy with SIX
 * decimals — same underlying balance, two views. The NativeERC20 Router variant
 * deployed there keeps every pool-side amount (`getReserves`,
 * `getAmountsIn/OutCollection`, `amountETHMin`, returned `amountETH`) in quote units and
 * only `msg.value` / refunds / payouts in wei. The two are related by
 * `NATIVE_SCALE = 10 ** (18 - quoteDecimals)` = 1e12. `chains/units.ts` is the ONLY
 * module in this package allowed to convert between the two — never multiply or divide
 * a pool-side amount by `1e18` anywhere else.
 *
 * LATEST ONLY — NO LEGACY
 * ------------------------
 * Legacy was discontinued workspace-wide on 2026-08-10 (see the workspace root
 * CLAUDE.md, "Legacy — DESCONTINUADO"). This registry carries exactly the 14 current
 * production deploys and nothing else: no `mode` parameter exists on `getChain` or
 * anywhere else in `chains/`, and a future request for a Legacy deploy is an
 * `INVALID_PARAMS` failure, never a toggle to flip.
 *
 * SOURCING
 * --------
 * Every field below is copied from `snf-client/src/config/{chains,contracts,
 * subgraphs}.ts` (the production config the live app actually runs) or from
 * `snf-contracts/scripts/delegate-configs.ts` / `snf-contracts/deployments/<chainId>.json`
 * for `delegateNetFee`. `test/chains/coverage.test.ts` re-reads those same
 * `snf-client` files from disk and diffs every address field-by-field — a typo here
 * fails CI, it does not ship.
 */

/** Universal Multicall3 deployment address, identical on all 14 chains. */
export const MULTICALL3_ADDRESS: `0x${string}` = '0xcA11bde05977b3631167028862bE2a173976CA11'

export const SNF_CHAINS = [
  // ── Robinhood Chain (4663) — Arbitrum Nitro L2, ETH gas. Deploy 2026-08-09, the
  // canonical CREATE2 cluster. Delegate: Uniswap V2 (Robinhood Chain mainnet),
  // netFee verified empirically via router.getAmountsOut() — snf-contracts
  // scripts/delegate-configs.ts (origin/master).
  {
    chainId: 4663,
    name: 'Robinhood Chain',
    shortName: 'Robinhood',
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    factory: '0x85039B2e95558aDdCCf4379728b8433C447E37bE',
    router02: '0xDc0088a282d225f8cb08D092950Dde6eBAa36E78',
    routerVariant: 'standard',
    quoteToken: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
    quoteDecimals: 18,
    hasNativeWrapper: true,
    multicall3: MULTICALL3_ADDRESS,
    subgraphUrl:
      'https://api.goldsky.com/api/public/project_cmngb5qq6d79v01wba5bi7hdg/subgraphs/snf-robinhood/1.1.0/gn',
    explorerUrl: 'https://robinhoodchain.blockscout.com',
    // VERIFY-LIVE: no delegated NFT pair exists through the SnF Factory on Robinhood
    // Chain as of plan 18's fork session (snf-54-18-SUMMARY.md, Finding 5) — this
    // value is carried forward from `snf-contracts/scripts/delegate-configs.ts`'s
    // canonical netFee for the underlying DEX (Uniswap V2), NOT independently
    // re-verified against a live delegated pair's own `getAmountOut()` on THIS chain
    // (unlike Base/Arc, which were). Re-verify once a delegated pair is created here.
    delegateNetFee: 9970, // Uniswap V2 (Robinhood Chain mainnet)
    poolNetFee: 9800,
    defaultRpcUrl: 'https://rpc.mainnet.chain.robinhood.com',
  },

  // ── Ethereum (1) — redeployed 2026-04-15, canonical CREATE2 cluster. Delegate:
  // SushiSwap (Ethereum mainnet).
  {
    chainId: 1,
    name: 'Ethereum',
    shortName: 'Ethereum',
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    factory: '0x85039B2e95558aDdCCf4379728b8433C447E37bE',
    router02: '0xDc0088a282d225f8cb08D092950Dde6eBAa36E78',
    routerVariant: 'standard',
    quoteToken: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    quoteDecimals: 18,
    hasNativeWrapper: true,
    multicall3: MULTICALL3_ADDRESS,
    subgraphUrl:
      'https://api.goldsky.com/api/public/project_cmngb5qq6d79v01wba5bi7hdg/subgraphs/snf-mainnet/1.1.0/gn',
    explorerUrl: 'https://etherscan.io',
    delegateNetFee: 9970, // SushiSwap (Ethereum mainnet)
    poolNetFee: 9800,
    defaultRpcUrl: 'https://eth.merkle.io',
  },

  // ── Base (8453) — NOT the canonical cluster: its own Factory/Router. Delegate:
  // Uniswap V2 (Base mainnet).
  {
    chainId: 8453,
    name: 'Base',
    shortName: 'Base',
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    factory: '0x611103410C8021B51725ab38Cc79C8F0feD715c6',
    router02: '0x1312488a7BF5aAF2B2EeBE8393c9616A1418CF04',
    routerVariant: 'standard',
    quoteToken: '0x4200000000000000000000000000000000000006',
    quoteDecimals: 18,
    hasNativeWrapper: true,
    multicall3: MULTICALL3_ADDRESS,
    subgraphUrl:
      'https://api.goldsky.com/api/public/project_cmngb5qq6d79v01wba5bi7hdg/subgraphs/snf-base/1.1.0/gn',
    explorerUrl: 'https://basescan.org',
    delegateNetFee: 9970, // Uniswap V2 (Base mainnet)
    poolNetFee: 9800,
    defaultRpcUrl: 'https://mainnet.base.org',
  },

  // ── Arbitrum One (42161) — redeployed 2026-04-15, canonical CREATE2 cluster.
  // Delegate: SushiSwap (Arbitrum mainnet).
  {
    chainId: 42161,
    name: 'Arbitrum',
    shortName: 'Arbitrum',
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    factory: '0x85039B2e95558aDdCCf4379728b8433C447E37bE',
    router02: '0xDc0088a282d225f8cb08D092950Dde6eBAa36E78',
    routerVariant: 'standard',
    quoteToken: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    quoteDecimals: 18,
    hasNativeWrapper: true,
    multicall3: MULTICALL3_ADDRESS,
    subgraphUrl:
      'https://api.goldsky.com/api/public/project_cmo0byz6wpdci01vt2k7p3l2q/subgraphs/snf-arbitrum/1.0.0/gn',
    explorerUrl: 'https://arbiscan.io',
    delegateNetFee: 9970, // SushiSwap (Arbitrum mainnet)
    poolNetFee: 9800,
    defaultRpcUrl: 'https://arb1.arbitrum.io/rpc',
  },

  // ── Polygon (137) — redeployed 2026-04-15, canonical CREATE2 cluster. Native
  // symbol is POL (post-rebrand), not MATIC. Delegate: SushiSwap (Polygon mainnet).
  {
    chainId: 137,
    name: 'Polygon',
    shortName: 'Polygon',
    nativeSymbol: 'POL',
    nativeDecimals: 18,
    factory: '0x85039B2e95558aDdCCf4379728b8433C447E37bE',
    router02: '0xDc0088a282d225f8cb08D092950Dde6eBAa36E78',
    routerVariant: 'standard',
    quoteToken: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
    quoteDecimals: 18,
    hasNativeWrapper: true,
    multicall3: MULTICALL3_ADDRESS,
    subgraphUrl:
      'https://api.goldsky.com/api/public/project_cmo0byz6wpdci01vt2k7p3l2q/subgraphs/snf-polygon/1.0.0/gn',
    explorerUrl: 'https://polygonscan.com',
    delegateNetFee: 9970, // SushiSwap (Polygon mainnet)
    poolNetFee: 9800,
    defaultRpcUrl: 'https://polygon.drpc.org',
  },

  // ── HyperEVM (999) — single deploy 2026-04-28, own Factory/Router (no Alchemy
  // coverage, public RPC is the only option on this chain, matching snf-client).
  // Delegate: HyperSwap (Hyperliquid mainnet).
  {
    chainId: 999,
    name: 'HyperEVM',
    shortName: 'HyperEVM',
    nativeSymbol: 'HYPE',
    nativeDecimals: 18,
    factory: '0xa575959Ab114BF3a84A9B7D92838aC3b77324E65',
    router02: '0x1c865C75ab96aEbe4F3beEb4388036047240096b',
    routerVariant: 'standard',
    quoteToken: '0x5555555555555555555555555555555555555555',
    quoteDecimals: 18,
    hasNativeWrapper: true,
    multicall3: MULTICALL3_ADDRESS,
    subgraphUrl:
      'https://api.goldsky.com/api/public/project_cmo0byz6wpdci01vt2k7p3l2q/subgraphs/snf-hyperevm/1.0.0/gn',
    explorerUrl: 'https://hyperevmscan.io',
    delegateNetFee: 9970, // HyperSwap (Hyperliquid mainnet)
    poolNetFee: 9800,
    defaultRpcUrl: 'https://rpc.hyperliquid.xyz/evm',
  },

  // ── Apechain (33139) — single deploy 2026-04-28, canonical CREATE2 cluster.
  // Delegate: Camelot V2 (Apechain mainnet).
  {
    chainId: 33139,
    name: 'Apechain',
    shortName: 'Apechain',
    nativeSymbol: 'APE',
    nativeDecimals: 18,
    factory: '0x85039B2e95558aDdCCf4379728b8433C447E37bE',
    router02: '0xDc0088a282d225f8cb08D092950Dde6eBAa36E78',
    routerVariant: 'standard',
    quoteToken: '0x48b62137EdfA95a428D35C09E44256a739F6B557',
    quoteDecimals: 18,
    hasNativeWrapper: true,
    multicall3: MULTICALL3_ADDRESS,
    subgraphUrl:
      'https://api.goldsky.com/api/public/project_cmoiys0pk3brg01un76ukdj5r/subgraphs/snf-apechain/1.0.0/gn',
    explorerUrl: 'https://apescan.io',
    delegateNetFee: 9970, // Camelot V2 (Apechain mainnet)
    poolNetFee: 9800,
    defaultRpcUrl: 'https://apechain.drpc.org',
  },

  // ── Berachain (80094) — single deploy 2026-04-28, canonical CREATE2 cluster.
  // Delegate: Kodiak V2 (Berachain mainnet).
  {
    chainId: 80094,
    name: 'Berachain',
    shortName: 'Berachain',
    nativeSymbol: 'BERA',
    nativeDecimals: 18,
    factory: '0x85039B2e95558aDdCCf4379728b8433C447E37bE',
    router02: '0xDc0088a282d225f8cb08D092950Dde6eBAa36E78',
    routerVariant: 'standard',
    quoteToken: '0x6969696969696969696969696969696969696969',
    quoteDecimals: 18,
    hasNativeWrapper: true,
    multicall3: MULTICALL3_ADDRESS,
    subgraphUrl:
      'https://api.goldsky.com/api/public/project_cmoiys0pk3brg01un76ukdj5r/subgraphs/snf-berachain/1.0.0/gn',
    explorerUrl: 'https://berascan.com',
    delegateNetFee: 9970, // Kodiak V2 (Berachain mainnet)
    poolNetFee: 9800,
    defaultRpcUrl: 'https://rpc.berachain.com',
  },

  // ── Monad (143) — single deploy 2026-04-28, canonical CREATE2 cluster. Delegate:
  // Uniswap V2 (Monad mainnet).
  {
    chainId: 143,
    name: 'Monad',
    shortName: 'Monad',
    nativeSymbol: 'MON',
    nativeDecimals: 18,
    factory: '0x85039B2e95558aDdCCf4379728b8433C447E37bE',
    router02: '0xDc0088a282d225f8cb08D092950Dde6eBAa36E78',
    routerVariant: 'standard',
    quoteToken: '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A',
    quoteDecimals: 18,
    hasNativeWrapper: true,
    multicall3: MULTICALL3_ADDRESS,
    subgraphUrl:
      'https://api.goldsky.com/api/public/project_cmoiys0pk3brg01un76ukdj5r/subgraphs/snf-monad/1.0.0/gn',
    explorerUrl: 'https://monadexplorer.com',
    delegateNetFee: 9970, // Uniswap V2 (Monad mainnet)
    poolNetFee: 9800,
    defaultRpcUrl: 'https://rpc.monad.xyz',
  },

  // ── Abstract (2741) — single deploy 2026-06-15, zkSync Era stack (own
  // Factory/Router — different CREATE2 formula than the EVM cluster). Delegate:
  // Uniswap V2 fork (Abstract mainnet — zkSync Era).
  {
    chainId: 2741,
    name: 'Abstract',
    shortName: 'Abstract',
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    factory: '0x4a1775B76D9d4260C60f3376eCDA618e316c662D',
    router02: '0x50aC33C74a0262174DACa88260338D5F7BAf7606',
    routerVariant: 'standard',
    quoteToken: '0x3439153EB7AF838Ad19d56E1571FBD09333C2809',
    quoteDecimals: 18,
    hasNativeWrapper: true,
    multicall3: MULTICALL3_ADDRESS,
    subgraphUrl:
      'https://api.goldsky.com/api/public/project_cmejhyc7rqen501wed6sxgbn3/subgraphs/snf-abstract/1.0.0/gn',
    explorerUrl: 'https://abscan.org',
    delegateNetFee: 9970, // Uniswap V2 fork (Abstract mainnet — zkSync Era)
    poolNetFee: 9800,
    defaultRpcUrl: 'https://api.mainnet.abs.xyz',
  },

  // ── Ronin (2020) — single deploy 2026-06-15, canonical CREATE2 cluster (Sky
  // Mavis / Axie sidechain). Delegate: Katana V2 (Ronin mainnet).
  {
    chainId: 2020,
    name: 'Ronin',
    shortName: 'Ronin',
    nativeSymbol: 'RON',
    nativeDecimals: 18,
    factory: '0x85039B2e95558aDdCCf4379728b8433C447E37bE',
    router02: '0xDc0088a282d225f8cb08D092950Dde6eBAa36E78',
    routerVariant: 'standard',
    quoteToken: '0xe514d9DEB7966c8BE0ca922de8a064264eA6bcd4',
    quoteDecimals: 18,
    hasNativeWrapper: true,
    multicall3: MULTICALL3_ADDRESS,
    subgraphUrl:
      'https://api.goldsky.com/api/public/project_cmejhyc7rqen501wed6sxgbn3/subgraphs/snf-ronin/1.0.0/gn',
    explorerUrl: 'https://app.roninchain.com',
    delegateNetFee: 9970, // Katana V2 (Ronin mainnet)
    poolNetFee: 9800,
    defaultRpcUrl: 'https://api.roninchain.com/rpc',
  },

  // ── Avalanche C-Chain (43114) — single deploy 2026-07-08, canonical CREATE2
  // cluster. Delegate: Trader Joe V1 (Avalanche mainnet) — this is the chain that
  // named the live `DELEGATE_NET_FEE` constant in Delegation.sol.
  {
    chainId: 43114,
    name: 'Avalanche',
    shortName: 'Avalanche',
    nativeSymbol: 'AVAX',
    nativeDecimals: 18,
    factory: '0x85039B2e95558aDdCCf4379728b8433C447E37bE',
    router02: '0xDc0088a282d225f8cb08D092950Dde6eBAa36E78',
    routerVariant: 'standard',
    quoteToken: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7',
    quoteDecimals: 18,
    hasNativeWrapper: true,
    multicall3: MULTICALL3_ADDRESS,
    subgraphUrl:
      'https://api.goldsky.com/api/public/project_cmejhyc7rqen501wed6sxgbn3/subgraphs/snf-avalanche/1.0.0/gn',
    explorerUrl: 'https://snowtrace.io',
    delegateNetFee: 9970, // Trader Joe V1 (Avalanche mainnet)
    poolNetFee: 9800,
    defaultRpcUrl: 'https://api.avax.network/ext/bc/C/rpc',
  },

  // ── BNB Chain (56) — deploy 2024-10-30, own Factory/Router (Base-Latest
  // generation, byte-identical Pair init code hash to Base — NOT the canonical
  // cluster). Delegate: SushiSwap (BNB mainnet), netFee 9970 confirmed explicitly
  // in snf-contracts/deployments/56.json's `delegate` block (immutable, no setter).
  {
    chainId: 56,
    name: 'BNB Chain',
    shortName: 'BNB',
    nativeSymbol: 'BNB',
    nativeDecimals: 18,
    factory: '0x1fC0D65ae98F69cD8DCDA4ec0F6155A5F2a7b0ab',
    router02: '0x790488868E4b2eDb166778D67142035091eb130A',
    routerVariant: 'standard',
    quoteToken: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
    quoteDecimals: 18,
    hasNativeWrapper: true,
    multicall3: MULTICALL3_ADDRESS,
    subgraphUrl:
      'https://api.goldsky.com/api/public/project_cmnyu0s049bde01vr754rehxg/subgraphs/snf-bsc/1.0.0/gn',
    explorerUrl: 'https://bscscan.com',
    delegateNetFee: 9970, // SushiSwap (BNB mainnet)
    poolNetFee: 9800,
    defaultRpcUrl: 'https://bsc-dataseed.bnbchain.org',
  },

  // ── Arc (5042) — Circle L1, deploy 2026-09-16, canonical CREATE2 cluster
  // addresses but the NativeERC20 Router variant. `quoteToken` is the USDC ERC-20
  // predeploy (6 decimals), NOT a WETH9 wrapper — see abis/
  // UniswapV2Router01CollectionNativeERC20.ts and chains/units.ts. Delegate:
  // DyorSwap V2 (Arc mainnet), netFee verified empirically via getAmountOut.
  {
    chainId: 5042,
    name: 'Arc',
    shortName: 'Arc',
    nativeSymbol: 'USDC',
    nativeDecimals: 18,
    factory: '0x85039B2e95558aDdCCf4379728b8433C447E37bE',
    router02: '0xDc0088a282d225f8cb08D092950Dde6eBAa36E78',
    routerVariant: 'native-erc20',
    quoteToken: '0x3600000000000000000000000000000000000000',
    quoteDecimals: 6,
    hasNativeWrapper: false,
    multicall3: MULTICALL3_ADDRESS,
    subgraphUrl:
      'https://api.goldsky.com/api/public/project_cmngb5qq6d79v01wba5bi7hdg/subgraphs/snf-arc/1.0.0/gn',
    explorerUrl: 'https://explorer.arc.io',
    // VERIFY-LIVE: verified empirically at 9970 via the delegate's own
    // `getAmountOut()` in plan 03 (`snf-54-03-SUMMARY.md`) — kept here as a live
    // pointer rather than a bare "trust me" comment, since `snf-contracts/scripts/
    // delegate-configs.ts` (the canonical source other chains cite) has NO row for
    // chainId 5042 at all (snf-54-18-SUMMARY.md, Finding 5). Re-verify if the
    // delegate pair (DyorSwap V2) is ever redeployed or its fee tier changes.
    delegateNetFee: 9970, // DyorSwap V2 (Arc mainnet)
    poolNetFee: 9800,
    defaultRpcUrl: 'https://rpc.mainnet.arc.io',
  },
] as const satisfies readonly SnfChainConfig[]

/** The 14 supported chain ids, in registry order. */
export const SNF_CHAIN_IDS: readonly SnfChainId[] = SNF_CHAINS.map((c) => c.chainId)

/** Returns the config for a supported chain, or throws `SnfError` (code
 * `INVALID_PARAMS`) — the registry can never return `undefined`. Arity 1: no `mode`
 * parameter exists. */
export function getChain(id: number): SnfChainConfig {
  const found = SNF_CHAINS.find((c) => c.chainId === id)
  if (!found) {
    throw new SnfError('INVALID_PARAMS', `Unsupported chain: ${id}`, {
      details: { chainId: id, supported: SNF_CHAIN_IDS },
    })
  }
  return found
}

/** True if `id` is one of the 14 supported chains. */
export function isSupportedChain(id: number): id is SnfChainId {
  return SNF_CHAINS.some((c) => c.chainId === id)
}
