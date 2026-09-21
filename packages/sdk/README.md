# `@sweepnflip/sdk`

Headless TypeScript SDK for quoting and executing swaps against Sweep n' Flip NFT AMM
pools — client-direct, unsigned calldata only. Never signs, never relays, never
custodies. `viem` is the only peer.

## Install

```sh
pnpm add @sweepnflip/sdk viem
```

Until Phase 55's first `npm publish` (D-08), consume this package from a local
checkout via `pnpm link` or a tarball (`pnpm pack`).

## Minimal snippet

```ts
import { createSnfClient } from '@sweepnflip/sdk'

const snf = createSnfClient({ chainId: 8453, publicClient })
const col = await snf.collection('0x…')
const q = await snf.quoteBuy({ collection: col.address, tokenIds: ['1', '2', '3'] })
const plan = await snf.buildBuy({ quote: q, recipient, slippageBps: 100 })
await plan.preflight()
```

See the root README's [`## Quickstart`](../../README.md#quickstart) for the full,
runnable sequence, and [`examples/vanilla`](../../examples/vanilla) for the script it
is lifted from.

## Docs

- Root README (chain table, security posture, footguns this SDK hides): [`../../README.md`](../../README.md)
- Security policy: [`../../SECURITY.md`](../../SECURITY.md)
- Permissionless parity checklist: [`../../PARITY.md`](../../PARITY.md)
