# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Versioning policy

Both `@sweepnflip/sdk` and `@sweepnflip/sdk-react` stay on `0.x` until a real,
small-value purchase has been verified end-to-end against the Base ETH/DEMON pool.
While on `0.x`, the public API may still change between minor versions — pin an exact
version if you need stability. `0.1.0` was the first `npm publish`. From `1.0.0`
onward, breaking changes only ship in a major version, with a documented overlap of at
least 6 months for any deprecated surface.

## [Unreleased]

Liquidity: add/remove/create-pool, a launch-seeding helper, LP position reads, and a
fixed redemption probe; and read-only portfolio reads (LP positions, wNFT balances,
held collections, pool history) plus canonical links into the public app. Ships in
a later minor release, not `0.1.2` or `0.2.0` — no `package.json`/`SDK_VERSION` bump
in this entry.

### Added

**`@sweepnflip/sdk`** — eleven new client methods:

- `quoteAddLiquidity` / `buildAddLiquidity` — on-chain-reconciled deposit quote and
  unsigned plan for an EXISTING pool, native or ERC-20 base (Arc included), with
  dynamic gas and only the approvals actually missing.
- `quoteCreatePool` / `buildCreatePool` — the same for a pool-creating deposit, always
  at an EXACT minimum (never zero, never loosened) — this closes the same-block
  pre-seed front-run a looser minimum would let through untouched.
- `quoteRemoveLiquidity` / `buildRemoveLiquidity` — withdrawal in `nft` mode (whole
  NFTs plus a fractional wNFT remainder) or `wnft` mode (the fungible wrapper only, at
  any share size, including a share too small for one whole NFT); a plain LP
  `Pair.approve` step, no permit variant (none exists for the collection-aware remove
  path).
- `buildSeed` — an explicitly OPTIONAL launch-seeding builder: up to 500 NFTs per
  call, split into consecutive ≤50-id steps at exact minimums, explicit LP
  destination, no default and no burn shortcut. A partner who never calls this can
  still seed a pool with a single plain deposit call — nothing in this package makes
  it a prerequisite.
- `lpPosition(pair, owner)` — a single pair's live LP balance, share, and underlying
  base/wNFT/whole-NFT breakdown.
- `redemptionStatus(collection)` — a tri-state (`allowed` / `blocked` / `unknown`)
  probe of whether a collection currently lets NFTs leave its wrapper, sourced from
  on-chain enumeration or the subgraph — no Alchemy dependency.
- `seeding(collection)` / `attestation(collection)` — typed reads that reject
  `PRODUCT_NOT_LIVE` on every chain today; the underlying contract is neither audited
  nor deployed anywhere, so no ABI, address or struct shape ships until it is.

Type surface: `Quote.side` widened with `'add-liquidity' | 'remove-liquidity' |
'create-pool'`, plus an optional `Quote.liquidity` sub-object every liquidity quote
carries (reserves, balances, totalSupply, the exact base/LP/wNFT figures, block
number). `StepKind` gains `'add-liquidity' | 'remove-liquidity'` (a pool-creating
deposit is still `'add-liquidity'`, disambiguated by `quote.side`). `Approval.kind`
gains `'lp-allowance'`. `Bounds` gains `amountInMin` (deposits — equals the exact
minimum on a create/seed) and `wnftOutMin` (withdrawals). `StepPreflightRefs.wrapper`
and `.pair` are now nullable (a step whose own transaction creates one or both), and
`.lpBurn` lets `plan.preflight()` re-verify a withdrawal's live LP balance and, in
`nft` mode, the exact whole-NFT count at the signing block. `describeError` maps four
new Router revert strings (`INSUFFICIENT_A_AMOUNT`/`_B_AMOUNT`,
`EXCESSIVE_A_AMOUNT`/`_B_AMOUNT`) to `INSUFFICIENT_OUTPUT_AMOUNT`, and a bad ERC-20
`transferFrom` to `INVALID_PARAMS`.

**`@sweepnflip/sdk`** — portfolio: four more read-only client methods, every one
scoped to the client's own chain, no exceptions:

- `positions(owner)` — every SnF LP position this owner holds, described at one
  pinned block; `valueInBase` is marked at the pool's own mid price (never a
  liquidation quote), `valueUsd` only when a `prices` provider is configured, and a
  failure on one pair is isolated to `skipped` rather than failing the whole call.
- `wnftBalances(owner)` — every fungible wNFT balance for a collection with an SnF
  pool on this chain, Factory-identity-verified, mid-valued against the wrapper's own
  native pool only.
- `collectionsHeld(owner)` — the pooled collections this owner holds through the
  optional `walletNfts` provider; `status: 'unavailable'` with zero I/O when none is
  configured — never a silent empty list — and an on-chain `ERC721.balanceOf` count
  once one is.
- `poolHistory(pair, interval, opts?)` — a pool's sparse volume/reserve history,
  bucketed by day or 730-hour month, oriented by the wrapper side, cached for 5
  minutes (`config.subgraph.historyTtlMs`).
- `appLinks.pool` / `.liquidity` / `.swap` — canonical links into the public app,
  every one carrying `chain={chainId}` so a visitor's wallet or app state can never
  silently disagree with the link they clicked; `opts.origin` overrides the default
  origin and must be a bare `https:` origin, or throws.
- `PricesProvider.getTokenUsd?(chainId, token)` — optional, consulted only for an
  ERC-20-base pool; a native base still uses `getNativeUsd`. No price ever reads as
  `valueUsd: 0` — an absent, throwing, or non-finite/non-positive answer all collapse
  to the same outcome: `undefined`.

Every portfolio read covers ONE chain — the chain of the client it was called on. A
partner covering several chains creates one client per chain and loops over them; a
single call spanning several chains is planned for a later release. There is likewise
no totals helper: values can sit in different base tokens, so a partner who wants one
number sums `valueUsd` across whichever results have it defined.

**`@sweepnflip/sdk-react`** — thirteen new hooks: five read hooks
(`useSnfQuoteAddLiquidity`, `useSnfQuoteCreatePool`, `useSnfQuoteRemoveLiquidity`,
`useSnfLpPosition`, `useSnfRedemptionStatus`) mirroring `useSnfQuoteBuy`'s own
cache/key/enabled/error contract, four build hooks (`useSnfAddLiquidity`,
`useSnfCreatePool`, `useSnfRemoveLiquidity`, `useSnfSeed`) that only touch the chain
when a partner calls `build(args)`, feeding the resulting plan to the existing
`useSnfCheckout(plan)`, and four portfolio hooks (`useSnfPositions`,
`useSnfWnftBalances`, `useSnfCollectionsHeld`, `useSnfPoolHistory`) whose cadence
follows the data source — 30-second polling for the two on-chain balance reads, none
at all for the partner-indexer and the 5-minute-cached history read.

### Changed

- **The no-backend lint rule and the grep gate now block `sweepnflip.io/api`
  (backend paths) rather than every `sweepnflip.io` literal.** `appLinks` needs to
  hardcode the public app's own origin once to build a shareable link; the narrower
  pattern still catches any accidental call to the private backend while allowing a
  link to the app itself.

- **The redemption probe now simulates `transferFrom`, not `safeTransferFrom`.** The
  wrapper's own release path (`WERC721._burn`) calls `transferFrom`; the previous
  probe simulated the wrong function and could misclassify a collection that guards
  one but not the other. `CollectionInfo.redemptionLocked` and the `quoteBuy`/
  `quoteNftToNft` refusal now trigger only on a confirmed `'blocked'` probe result — an
  `'unknown'` result (no sample id, or an ambiguous revert) prices normally rather
  than refusing.
- Creation and seeding always send an EXACT minimum — never `0` and never loosened by
  slippage — because `_addLiquidity` never reads the minimums at all when a pair's
  reserves are both zero; a looser minimum is the same window a same-block pre-seed
  exploits.
- Withdrawal always uses a plain LP `Pair.approve` step, in both modes — no permit
  variant exists for the collection-aware remove path (`removeLiquidityETHCollection`
  / `removeLiquidityCollection`), and this package never encodes one.

### Changed

- Arc (5042): the built-in `subgraphUrl` now points to the subgraph's new host. The
  old URL keeps answering for a short overlap and is then retired; `0.1.x` installs
  that read Arc pool data from the subgraph should upgrade.

## [0.2.0] — 2026-09-29

`@sweepnflip/sdk` adds ERC-8021 partner attribution; additive, no breaking change.
`@sweepnflip/sdk-react` is republished as `0.2.0` with no code change, only so its
peer range on `@sweepnflip/sdk` (`^0.2.0`) admits the new minor.

### Added

**`@sweepnflip/sdk`** — ERC-8021 partner attribution:

- `createSnfClient({ attribution: { code } })` — every step the client builds for an
  SnF contract (Router02/Factory) now ends with an ERC-8021 schema-0 suffix: `sdk`
  without a code, `sdk-<code>` with one (for example `sdk-acme`). Approval steps are
  never tagged, gas is estimated on the suffixed calldata, and a bad code throws
  `INVALID_PARAMS` at construction. Contracts ignore the trailing bytes; no
  registration is needed.
- `encodeAttribution(codes)` / `parseAttribution(data)` — encode a suffix for a
  transaction the SDK did not build, and read the codes back from any calldata
  (strict: `null` for anything that is not a well-formed schema-0 suffix).
- `validatePartnerCode(code)` / `toSdkCode(code?)` — the partner-code grammar the
  client enforces, exposed for pre-validation.

## [0.1.2] — 2026-09-25

`@sweepnflip/sdk` only; `@sweepnflip/sdk-react` is unchanged and stays `0.1.0`.

### Fixed

- **A buy that fails on slippage is reported as a price move.** The Router refuses a
  buy that would cost more than `amountInMax` / `msg.value` with
  `EXCESSIVE_INPUT_AMOUNT`; `describeError` classified it as `INVALID_PARAMS`
  ("invalid request"), so a partner showed the wrong message and did not re-quote. It
  is now `INSUFFICIENT_OUTPUT_AMOUNT`, the same code as the sell-side slippage revert,
  with `details.revert` naming which one.
- **No quote for a purchase that cannot settle.** When a collection blocks NFTs from
  leaving its wrapper (`CollectionInfo.redemptionLocked`), `quoteBuy` (whole NFTs) and
  `quoteNftToNft` (a locked buy collection) now throw `REDEMPTION_LOCKED` instead of
  pricing a transaction that would revert on-chain and cost the buyer gas. A
  fractional `amount` buy, and selling into such a collection, are unaffected.

## [0.1.1] — 2026-09-24

`@sweepnflip/sdk` only; `@sweepnflip/sdk-react` is unchanged and stays `0.1.0`.

### Fixed

- **Quotes on an ERC-20-base pool are denominated in that token.** Every money field
  of `quoteBuy`, `quoteSell` and `quoteNftToNft` (totals, `fees.marketplace`,
  `fees.royalty`, leg amounts) used the chain's native symbol and decimals. On a
  USDC-base pool the total read as ETH with 18 decimals. `value` was always correct;
  `formatted`, `symbol` and `decimals` now come from the pool's `baseToken`.
- **`config.defaults` is applied.** `slippageBps` and `deadlineSeconds` set on
  `createSnfClient` were validated but never used; every `build*` call fell back to
  100 bps and 1200 s. Precedence is now: the call's own argument, then
  `config.defaults`, then the SDK constant. The hard caps still apply to all three.
- **Inventory is read from the pool the quote prices.** The README quickstart, both
  examples and the widgets read `pools[0]`, while `quoteBuy` without `payToken` prices
  the first native-base pool. When an ERC-20-base pool ranked first, the tokenIds
  shown came from a different pool than the price.
- **Approval and swap labels match the step.** An ERC-20 spending allowance was
  labelled "Approve collection" and a fungible swap "Confirm sale". They now read
  "Approve token spending" and "Confirm swap".
- **`SNF_ERROR_RETRYABLE` is exported as a value.** It was re-exported only as a type,
  so it could not be read at runtime.

## [0.1.0] — 2026-09-21

The first complete, buildable, testable surface of both packages.

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
  send — a receipt/rejection watcher is structurally incapable of dispatching, so every
  on-chain step maps to one explicit call from the caller, never an automatic advance.
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
  synchronous frame as `reset()` (never a `useEffect`-driven auto-advance), and feeds
  receipts/rejections back through the core's watcher-only entry points.

**Examples** — `examples/vanilla` (no-React proof, runs on bare Node against the live
Base ETH/DEMON pool through `plan.preflight()`) and `examples/next-app` (one page, four
sections: discovery → inventory → quote → checkout, wired to a real wallet via wagmi).

**Tooling** — `pnpm release:gate`: one command, five release blockers (surviving
`@gsd-stub` tokens, ABI inventory scope, a secrets scan over the repo and both
packages' `dist`, the 60 kB gzip bundle budget, and `SDK_VERSION`/`package.json#version`
consistency). `pnpm grep:gate`, `pnpm lint`, `pnpm -r typecheck`, `pnpm -r test`,
`pnpm test:fork`, `pnpm size` — all green at this release.

- 2026-09-20 — Toolchain installed: `typescript@5.9.3`, `prettier@3.9.8`, `eslint@9.39.4`, `typescript-eslint@8.70.0`, `tsup@8.5.1`, `vitest@5.0.1`, `@vitest/coverage-v8@5.0.1`, `size-limit@14.0.0`, `@size-limit/preset-small-lib@14.0.0`, `fast-check@4.10.2`, `@changesets/cli@3.0.3` (root); `viem@2.47.0` (`@sweepnflip/sdk`); `viem@2.47.0`, `wagmi@2.19.5`, `@tanstack/react-query@5.90.21`, `react@19.2.5`, `react-dom@19.2.5`, `@types/react@19.3.0`, `@testing-library/react@16.3.3`, `@testing-library/dom@10.4.2`, `jsdom@30.1.0` (`@sweepnflip/sdk-react`). `tsx` deliberately skipped in favor of the toolchain above. Bare `changesets` package never installed — only the scoped `@changesets/cli`.

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

`1.0.0` is not next. The next version bump happens together with the first real
`npm publish` and a generated docs site — both gated on a real, verified end-to-end
purchase against this `0.1.0` (see "Versioning policy" above), not on this changelog
alone.
