# snf-sdk — Sweep n' Flip Partner SDK

TypeScript SDK for partner marketplaces and launchpads to embed Sweep n' Flip NFT AMM
liquidity in their own front-ends — quote and execute buy/sell of whole NFTs and wNFT,
and NFT×NFT, against SnF pools on all supported chains. Client-direct: talks to the chain
(viem) and the public subgraph; no SnF server required; unsigned calldata only.

**Status:** private during development — goes public when ready for partners.
No product code yet: this repository was bootstrapped on 2026-09-19 after the founder
ratified the PRD and the Phase 54 SPEC. Development follows the GSD trail in
`snf-workspace` (`/gsd-discuss-phase 54` → `/gsd-plan-phase 54` → `/gsd-execute-phase 54`).

## Planned layout

```
packages/sdk/         @sweepnflip/sdk        — headless core (viem peer, no React)
packages/sdk-react/   @sweepnflip/sdk-react  — React hooks (wagmi + react-query peers)
packages/widgets/     @sweepnflip/widgets    — UI kit (Phase 56, later)
examples/             vanilla · next-app · bot
```

## Canonical documents (in `snf-workspace`)

- PRD: `.specs/features/snf-sdk/PRD.md`
- SPEC (Phase 54): `.planning/phases/snf-54-partner-sdk-foundation-swap/54-SPEC.md`
- Public API datasheet (types contract): `.specs/features/snf-api/DATASHEET.md`

## Security posture (non-negotiable)

Never signs, relays or custodies. Every value that enters a transaction is read on-chain at
build time. No third-party API keys ship in this package — partners inject their own
data providers.
