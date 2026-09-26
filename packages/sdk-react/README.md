# `@sweepnflip/sdk-react`

React hooks adapter for [`@sweepnflip/sdk`](https://www.npmjs.com/package/@sweepnflip/sdk)
— quote, build and checkout Sweep n' Flip NFT AMM swaps via `wagmi` + `@tanstack/react-query`.
`useSnfCheckout` is the ONE dispatch site in this whole adapter: every wallet
transaction it sends is the direct result of a user's own click, never a
`useEffect`-driven auto-advance.

## Install

```sh
pnpm add @sweepnflip/sdk @sweepnflip/sdk-react viem wagmi @tanstack/react-query
```

Until the first `npm publish`, consume this package from a local
checkout via `pnpm link` or a tarball (`pnpm pack`).

## Minimal snippet

```tsx
import { SnfProvider, useSnfQuoteBuy, useSnfCheckout } from '@sweepnflip/sdk-react'

// Wrap your app: <WagmiProvider>...<QueryClientProvider>...<SnfProvider chainId={8453} publicClient={publicClient}>

const { data: quote } = useSnfQuoteBuy({ collection, count })
const checkout = useSnfCheckout(plan)
<button onClick={() => void checkout.next()} disabled={!checkout.canProceed}>
  {checkout.label}
</button>
```

See the root README's [`## React`](../../README.md#react) section and
[`examples/next-app`](../../examples/next-app) for the full, running version:
discovery → inventory → quote → checkout on one screen.

## Liquidity

Nine hooks cover the full liquidity surface — five read hooks (mirroring the swap
quote hooks above) and four build hooks (mirroring `useSnfCheckout`'s own
`quote → build → checkout` shape). None of the four build hooks ever dispatches a
transaction itself; their plan always feeds `useSnfCheckout(plan)`.

- `useSnfQuoteAddLiquidity(args)` — price a deposit into an EXISTING pool.
- `useSnfQuoteCreatePool(args)` — price a brand-new pool's opening deposit.
- `useSnfQuoteRemoveLiquidity(args)` — price a withdrawal (`nft` or `wnft` mode).
- `useSnfLpPosition(pair, owner)` — an LP holder's live balance, share and
  underlying base/wNFT/whole-NFT breakdown.
- `useSnfRedemptionStatus(collection)` — a tri-state probe of whether a
  collection's wrapper currently lets NFTs redeem out.
- `useSnfAddLiquidity()` — `{ build, plan, isBuilding, error, reset }`; `build(args)`
  calls `client.buildAddLiquidity`.
- `useSnfCreatePool()` — same shape; `build(args)` calls `client.buildCreatePool`.
- `useSnfRemoveLiquidity()` — same shape; `build(args)` calls `client.buildRemoveLiquidity`.
- `useSnfSeed()` — same shape; `build(args)` calls `client.buildSeed` (entirely
  optional — a partner who never calls it can still seed a pool by any other means).

```tsx
const { data: quote } = useSnfQuoteAddLiquidity({ collection, tokenIds })
const { build, plan } = useSnfAddLiquidity()
const checkout = useSnfCheckout(plan)

async function onDeposit() {
  if (quote) await build({ quote, recipient })
}
```

## Docs

- Root README (chain table, security posture, footguns this SDK hides): [`../../README.md`](../../README.md)
- Security policy: [`../../SECURITY.md`](../../SECURITY.md)
- Permissionless parity checklist: [`../../PARITY.md`](../../PARITY.md)
