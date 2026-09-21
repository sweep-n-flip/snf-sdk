# `@sweepnflip/sdk-react` — next-app example

## What it shows

A single page — discovery → inventory → quote → checkout — wired entirely through
`@sweepnflip/sdk-react`'s public hooks (`SnfProvider`, `useSnfClient`,
`useSnfCollection`, `useSnfPoolInventory`, `useSnfQuoteBuy`, `useSnfCheckout`) plus
`wagmi` for wallet connection. No RainbowKit, no design system, no CSS framework — a
handful of inline styles, four sections, one component per concern.

This is a **minimal app of our own**, not a mirror of the Drops Genesis checkout —
the two share a domain (buying NFTs from an SnF pool) but nothing else: no shared
code, no shared styling, no shared data wiring. A partner's real UI is their own;
this page exists to prove the public hooks are enough to build one, and to give a
partner a provider composition (`src/app/providers.tsx`) and a checkout pattern
(`src/components/SwapPanel.tsx`'s `CheckoutFlow`) they can copy.

## The four sections

1. **Collection** — resolve any address via `useSnfCollection`, defaulting to the
   live Base ETH/DEMON collection. Shows the resolved display identity
   (`labels.name`/`labels.symbol` — never the raw address), `wrapperVerified`,
   `redemptionLocked` and the EIP-2981 royalty.
2. **Inventory** — `useSnfPoolInventory` on the collection's first pool: candidate
   count, source (`enumerable`/`subgraph`/`provider`), freshness and a `stale` badge.
   Candidate data only — `plan.preflight()` (run inside `buildBuy`) is what actually
   decides which tokenIds are still there at signing time.
3. **Quote** — `useSnfQuoteBuy` for N tokens: the fee breakdown (`marketplace`,
   `royalty`, `gross`) with both the `formatted` string and the raw `value` bigint,
   plus `priceImpact`, `deliverable`, `bestEffort` and `reconciled`.
4. **Checkout** — a "Build plan" button calls `client.buildBuy({ quote, recipient })`
   directly (there is no `useSnfBuildPlan` hook — `useSnfClient()` is the documented
   escape hatch for any client method without one). Once a plan exists,
   `useSnfCheckout(plan)` drives the rest: the step list, the current state, and
   **one button** wired to `next()`, disabled whenever `canProceed` is false. One
   click, one transaction — `next()` is never called from a `useEffect`/watcher
   anywhere in this file (INV-17). See `CheckoutFlow` in `SwapPanel.tsx`.

## How to run it

```sh
pnpm -C examples/next-app dev
# open http://localhost:3000
```

```sh
pnpm -C examples/next-app build   # production build — also what `pnpm -r build` runs
pnpm -C examples/next-app start
```

No `.env.local` is required to run this app — every value in `.env.example` is
optional (see below). Connect any injected EIP-1193 wallet (MetaMask, Rabby, ...) on
Base to walk the full flow, including a real checkout transaction.

## Environment

See `.env.example`. Both variables are optional:

- `NEXT_PUBLIC_RPC_URL` — your own Base RPC. Falls back to a public, keyless one.
- `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` — only needed if you add the
  `walletConnect()` connector (see the comment in `src/app/providers.tsx`) for
  QR/mobile wallets. The default `injected()` connector needs neither.

No `@sweepnflip` API key exists and none is needed — every read goes through your own
RPC via viem/wagmi, and every write goes through the connected wallet.

## A note on the public surface (finding, not a bug)

`CollectionInfo.labels` (`CollectionLabels`) currently exposes `name`/`symbol`/
`imageUrl` only — it does not surface a `nameIsFallback`-style flag the way the
production app's own name-resolution waterfall does. The underlying waterfall inside
`resolveCollection` still guarantees `name` is never address-shaped, so this is a
missing signal for UI treatment (e.g. dimming a fallback name), not a correctness
gap. Left as-is per this plan's own scope (`packages/sdk/src` is not editable from an
examples plan) and flagged here for whoever next touches `collection.types.ts`.
