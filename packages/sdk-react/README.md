# @sweepnflip/sdk-react

React hooks adapter for [`@sweepnflip/sdk`](../sdk) — `useSnfCollection`,
`useSnfPoolInventory`, `useSnfQuoteBuy`, `useSnfQuoteSell`, `useSnfQuoteNftToNft`,
`useSnfCheckout`, and friends. Wraps the framework-agnostic core in `react-query`
caching and dispatches transactions through `wagmi` (`sendTransaction` / `writeContract`)
only when the user explicitly advances the checkout — this package never auto-advances a
transaction from a receipt watcher.

**Status:** in development (Phase 54 — SDK-0 Foundation + SDK-1 Swap). No public API yet.

Peers: `@sweepnflip/sdk`, `wagmi`, `@tanstack/react-query`, `react`.
