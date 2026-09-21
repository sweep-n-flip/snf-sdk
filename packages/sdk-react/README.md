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

Until Phase 55's first `npm publish` (D-08), consume this package from a local
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

## Docs

- Root README (chain table, security posture, footguns this SDK hides): [`../../README.md`](../../README.md)
- Security policy: [`../../SECURITY.md`](../../SECURITY.md)
- Permissionless parity checklist: [`../../PARITY.md`](../../PARITY.md)
