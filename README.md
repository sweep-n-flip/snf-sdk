# snf-sdk — Sweep n' Flip Partner SDK

TypeScript SDK for partner marketplaces and launchpads to embed Sweep n' Flip NFT AMM
liquidity in their own front-ends: quote and execute buy/sell of whole NFTs, wNFT, and
NFT×NFT against SnF pools, on every chain SnF is live on. Client-direct — it talks to
the chain (via the partner's own `viem` `PublicClient`) and to the public SnF
subgraph, and hands back unsigned calldata. It never signs a transaction, never relays
one through an SnF-operated server, and never custodies a user's funds or NFTs — see
[`SECURITY.md`](./SECURITY.md) for the full posture.

**Status:** `0.x` — the public API may still change between minor versions; pin an
exact version if you need stability. `1.0.0` ships to npm once a real, small-value
purchase has been verified end-to-end against this package (see `CHANGELOG.md`'s
"Versioning policy").

## Install

```sh
pnpm add @sweepnflip/sdk viem
# React adapter, if you're on React:
pnpm add @sweepnflip/sdk-react wagmi @tanstack/react-query
```

Until the first `npm publish` ships, consume these packages from a local
checkout via `pnpm link` or a tarball (`pnpm pack`) — there is no private registry and
no GitHub Packages in between.

## Quickstart

The exact sequence [`examples/vanilla`](./examples/vanilla) runs against the live Base
ETH/DEMON pool — no React, no wallet, no private key required for anything up to
`plan.preflight()`. A test (`packages/sdk/test/release/surface.test.ts`) asserts this
block has not drifted from the example it is lifted from.

```ts
import { createPublicClient, http } from 'viem'
import { base } from 'viem/chains'
import { createSnfClient, describeError } from '@sweepnflip/sdk'

const publicClient = createPublicClient({ chain: base, transport: http(RPC) })
const snf = createSnfClient({ chainId: 8453, publicClient })

const col = await snf.collection(DEMON_COLLECTION)
const inv = await snf.poolInventory(col.pools[0].pair)
const q = await snf.quoteBuy({ collection: col.address, tokenIds: inv.tokenIds.slice(0, 3) })

const plan = await snf.buildBuy({ quote: q, recipient, slippageBps: 100 })
await plan.preflight()
// send each step in plan.steps with your own wallet — one click per step (see React below)
```

`buildBuy` re-quotes on-chain and computes unsigned calldata; `plan.preflight()` is one
Multicall3 read (ownership, pool-holds, wrapper identity, balance, chain) run in the
same frame as the signature. Neither one signs or sends anything — only the final
`step.tx` your own wallet sends does.

## React

```tsx
const { data: quote } = useSnfQuoteBuy({ collection, count })
const plan = quote && (await client.buildBuy({ quote, recipient }))
const checkout = useSnfCheckout(plan)
// state: 'review' -> 'ready-approve'? -> ... -> 'ready-buy' -> 'success' (one click per step)
<button onClick={() => void checkout.next()} disabled={!checkout.canProceed}>
  {checkout.label}
</button>
```

See [`examples/next-app`](./examples/next-app) for the full, running version: discovery
→ inventory → quote → checkout on one screen, wired to a real wallet via wagmi.

Prefer a prebuilt surface? [`packages/widgets`](./packages/widgets) holds `SnfTradeCard`
and `SnfPoolStats`, a headless kit you copy into your app as source and style freely —
see its README.

## Supported chains

All 14 chains SnF is live on, generated from `SNF_CHAINS` (`@sweepnflip/sdk`) — 18
decimals on every chain except Arc, whose pool side runs on the native USDC
predeploy's 6 decimals (`getQuoteDecimals(chainId)` — never assume 18, see the Arc
footnote below).

| Chain | chainId | Native symbol | Quote decimals |
| --- | --- | --- | --- |
| Ethereum | 1 | ETH | 18 |
| Polygon | 137 | POL | 18 |
| Monad | 143 | MON | 18 |
| BNB Chain | 56 | BNB | 18 |
| Ronin | 2020 | RON | 18 |
| Abstract | 2741 | ETH | 18 |
| HyperEVM | 999 | HYPE | 18 |
| Apechain | 33139 | APE | 18 |
| Berachain | 80094 | BERA | 18 |
| Arbitrum | 42161 | ETH | 18 |
| Avalanche | 43114 | AVAX | 18 |
| Base | 8453 | ETH | 18 |
| Robinhood Chain | 4663 | ETH | 18 |
| Arc | 5042 | USDC | 6 |

Arc's native gas token IS USDC (18 decimals on the EVM/`msg.value` side) and the pool
quote token is the SAME balance, read through a 6-decimal ERC-20 predeploy
(`0x3600…0000`) — there is no wrapped-USDC token. `toNativeValue`/`fromNativeValue`
(exported from `@sweepnflip/sdk`) are the only sanctioned conversion between the two
axes; never hardcode a `1e18`/`parseEther` literal against a pool-side amount.

## What the SDK does for you

- **`getAmountsInCollection` is gross, `getAmountsOutCollection` is net.** The Router's
  two read functions answer different questions; this SDK's `quoteBuy`/`quoteSell`
  already reconstruct the right one additively (pool leg + marketplace fee + royalty)
  and reconcile it against the Router's own on-chain read before returning a `Quote`.
- **`capRoyaltyFee=true` with a zero on-chain cap zeroes the creator's royalty
  entirely.** This SDK always calls with `capRoyaltyFee=false` and reports the
  uncapped royalty, with a warning when a cap would have zeroed it.
- **The NFT wrapper can be `token0` OR `token1`.** Every quote/build path reads
  `wrapperIsToken0` off the pair itself — never assumes an index.
- **A pool never sells its last item.** `quoteBuy`/`poolInventory` account for the
  AMM's own reserve floor; a request for "all of it" is rejected before it reaches the
  chain, not after a revert.
- **9800 (SnF's own pools) vs. the chain's delegate fee (9970 on every delegated
  chain today).** `quoteSwap` is delegate-aware and reads the right one per pool —
  never hardcode either.

## Security posture

This SDK never signs, never relays, and never custodies. Every value that affects a
transaction is read on-chain at build/pre-flight time — nothing is trusted from the
caller. Copying or editing this SDK does not avoid the marketplace fee or the creator
royalty: both are charged by the SnF Router on-chain, not by this client. Full
detail, the four non-negotiables, and how each is enforced: [`SECURITY.md`](./SECURITY.md).

## Free forever

There is no license key, no paywall, and no usage fee anywhere in this SDK, and there
never will be — the revenue is the on-chain volume it brings to SnF pools (the
2.5% marketplace fee, charged by the Router, not by this package).

## Scope

**In v1:** collection/pool discovery, pool inventory, buy/sell/NFT×NFT/
fungible quotes with a reconciled fee breakdown, execution-plan builders with
frame-of-signature pre-flight, a user-driven checkout state machine, and the React
adapter.

**Explicitly deferred:** liquidity (add/remove/create pool). Portfolio/LP
position reads.
Marketplace aggregation, third-party marketplace integrations,
sell-into-bids, and any atomic multi-step NFT×NFT execution
contract are out of scope for this SDK entirely for now.

## Development

```sh
pnpm i
pnpm -r build
pnpm -r test
pnpm test:fork      # 4-chain anvil fork lanes — Base, Arbitrum, Robinhood, Arc
pnpm lint
pnpm grep:gate      # no hardcoded third-party API hosts, process.env reads, or private-repo imports
pnpm size            # bundle budget: <= 60 kB gzip
pnpm release:gate    # stubs, ABI inventory, secrets, bundle, version — one command, five checks
```

## More documentation

- Full docs site: https://app.sweepnflip.io/docs/sdk (plain-text index for AI agents: https://app.sweepnflip.io/llms.txt)
- Permissionless parity checklist: [`PARITY.md`](./PARITY.md)
- Security posture: [`SECURITY.md`](./SECURITY.md)
- Release history: [`CHANGELOG.md`](./CHANGELOG.md)
