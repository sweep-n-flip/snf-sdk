# @sweepnflip/sdk

Headless TypeScript SDK for quoting and executing swaps against Sweep n' Flip NFT AMM pools.

Client-direct: talks to the chain (via a `viem` `PublicClient` you supply) and the public
subgraph — no Sweep n' Flip server in the loop, no API key required. Every value that
enters a transaction is read on-chain at build time. This package never signs, relays or
custodies funds — it returns an `ExecutionPlan` of unsigned calldata for your own wallet
stack to send.

**Status:** in development (Phase 54 — SDK-0 Foundation + SDK-1 Swap). No public API yet.

See the workspace root `README.md` and the canonical documents it links for the full
design (`createSnfClient`, quote/build/preflight/checkout surface, chain coverage).
