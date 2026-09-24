# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Versioning policy

Both `@sweepnflip/sdk` and `@sweepnflip/sdk-react` stay on `0.x` until the founder's UAT
(a real, small-value purchase against the Base ETH/DEMON pool). `1.0.0` — and
the first `npm publish` — happen together, when the repo also goes public.
From `1.0.0` onward, breaking changes only ship in a major version, with a
documented overlap of at least 6 months for any deprecated surface.

## [Unreleased]

Nothing since `0.1.0` — this repository is not yet published (`1.0.0`, the first
`npm publish`, and the repo going public all happen together, after the
founder's UAT of this `0.1.0`).

## [0.1.0] — 2026-09-21 (unpublished — internal, pre-founder-UAT)

The first complete, buildable, testable
surface of both packages. Not yet published to npm and this repository is not yet
public — `pnpm link`/`pnpm pack` only, until the repo goes public.

### Added

**`@sweepnflip/sdk`** — headless core, `viem` the only peer:

- `createSnfClient(config)` — the one documented entry point; every domain operation
  is a method on the client it returns.
- Collection/pool discovery: `client.collection(address)` → wrapper, pools, royalty
  (EIP-2981, uncapped), `wrapperVerified`.
- `client.poolInventory(pair)` — candidate tokenIds with freshness/staleness metadata.
- Quotes, reconciled to the wei against a live on-chain Router read:
  `client.quoteBuy`, `client.quoteSell`, `client.quoteNftToNft`, `client.quoteSwap`
  (delegate-aware, 9800 SnF-native vs. 9970 on every delegated chain).
- Execution-plan builders with on-chain-derived bounds (never trusting a caller-supplied
  quote for `value`/`amountOutMin`): `client.buildBuy`, `client.buildSell`,
  `client.buildNftToNft`, `client.buildSwap` → `ExecutionPlan { steps[], preflight() }`.
- `plan.preflight()` — the frame-of-signature pre-flight: ownership, pool-holds,
  wrapper identity, balance, and chain, in one Multicall3 call at one block.
- `client.parseReceipt` — settled amounts read from the receipt's own logs (never a
  wallet-balance diff), including the wNFT-remainder gap fixed here (Finding 3).
- `createCheckout(plan)` (subpath `@sweepnflip/sdk/checkout`) — a headless, user-driven
  checkout state machine; `next()` is the only member that can ever produce a `Step` to
  send (INV-17): a receipt/rejection watcher is structurally incapable of dispatching.
- `SnfError` / `SNF_ERROR_CODES` — every public rejection is a typed, retryable-aware
  error; `describeError` normalises any thrown value into one.
- `SNF_CHAINS` / `getChain` / `isSupportedChain` — the 14-chain registry (chain id,
  native symbol, quote decimals, delegate variant, router variant).
- `toNativeValue` / `fromNativeValue` / `getQuoteDecimals` / `getQuoteScale` /
  `assertExactNativeMultiple` — the two-unit-axes module: 18 decimals on 13
  chains, 6 on Arc's native-USDC predeploy, one sanctioned conversion path.
- `formatAmount` / `toAmount` — the `{ value, formatted }` money convention: never parse
  `formatted` back for math.
- `abis` — the nine audited AMM ABI consts (ERC-20/ERC-721/IERC2981/Factory/Pair/
  Router02Collection/the Arc NativeERC20 Router variant/WERC721/WETH9), nothing
  outside this SDK's audited AMM surface.
- Four anvil fork lanes (Base, Arbitrum, Robinhood, Arc) and a keyless, read-only live
  backstop (in a separate, private exploration repo) reconciling all four on every run.
- Seven standing prohibition tests: no signing surface, no module-global state, no SnF
  backend calls, no `process.env` reads, and the release gate's own five checks.

**`@sweepnflip/sdk-react`** — React hooks adapter, `wagmi`/`@tanstack/react-query`/
`react` peers:

- `SnfProvider` — wraps a `viem` `PublicClient` + chain id into React context.
- `useSnfClient`, `useSnfCollection`, `useSnfPoolInventory`, `useSnfQuoteBuy`,
  `useSnfQuoteSell`, `useSnfQuoteNftToNft` — thin `useQuery` wrappers over the core.
- `useSnfCheckout(plan)` — the ONE dispatch site in either package: calls `next()` from
  a click, sends whatever `Step` it returns via wagmi's `useSendTransaction` in the same
  synchronous frame as `reset()` (never a `useEffect`-driven auto-advance — INV-17),
  and feeds receipts/rejections back through the core's
  watcher-only entry points.

**Examples** — `examples/vanilla` (no-React proof, runs on bare Node against the live
Base ETH/DEMON pool through `plan.preflight()`) and `examples/next-app` (one page, four
sections: discovery → inventory → quote → checkout, wired to a real wallet via wagmi).

**Tooling** — `pnpm release:gate`: one command, five release blockers (surviving
`@gsd-stub` tokens, ABI inventory scope, a secrets scan over the repo and both
packages' `dist`, the 60 kB gzip bundle budget, and `SDK_VERSION`/`package.json#version`
consistency). `pnpm grep:gate`, `pnpm lint`, `pnpm -r typecheck`, `pnpm -r test`,
`pnpm test:fork`, `pnpm size` — all green at this release.

- 2026-09-20 — Toolchain installed after founder approval: `typescript@5.9.3`, `prettier@3.9.8`, `eslint@9.39.4`, `typescript-eslint@8.70.0`, `tsup@8.5.1`, `vitest@5.0.1`, `@vitest/coverage-v8@5.0.1`, `size-limit@14.0.0`, `@size-limit/preset-small-lib@14.0.0`, `fast-check@4.10.2`, `@changesets/cli@3.0.3` (root); `viem@2.47.0` (`@sweepnflip/sdk`); `viem@2.47.0`, `wagmi@2.19.5`, `@tanstack/react-query@5.90.21`, `react@19.2.5`, `react-dom@19.2.5`, `@types/react@19.3.0`, `@testing-library/react@16.3.3`, `@testing-library/dom@10.4.2`, `jsdom@30.1.0` (`@sweepnflip/sdk-react`). `tsx` skipped (founder decision). Bare `changesets` package never installed — only the scoped `@changesets/cli`.

### Known gaps (tracked, not blocking)

- `CollectionInfo.labels.imageUrl` is declared but never populated — no per-token
  artwork resolution exists yet (`PARITY.md`'s one `not-covered` row).
- `delegateNetFee` for Robinhood Chain (4663) and Arc (5042) has no canonical-source
  row in the deployed-contracts registry; Arc's `9970` is empirically verified, Robinhood's is not (no
  live delegated pair exists there yet to verify against).
- A real value-moving Router write on Arc reverts on a generic anvil fork (a chain
  precompile anvil does not implement) — a fork-simulation fidelity gap, not an SDK
  defect; every read path is fully verified (Finding 4).

### Gate

`1.0.0` is not next. The next version bump on either package happens together with:
the first real `npm publish`, the `sweep-n-flip/snf-sdk` repository going public, and
a generated docs site — all three gated on the founder's own UAT of this `0.1.0`,
never on an agent's say-so.
