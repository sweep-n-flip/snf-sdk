# Permissionless parity checklist

REQ-SDK-50: a partner using `@sweepnflip/sdk`/`@sweepnflip/sdk-react` must be able to
build everything the `snf-drops-registration` Genesis checkout does, without reaching
into that repo's private code. This file is the honest, per-release proof of that
claim — re-checked at every release, not written once and forgotten. One row per
module the Genesis "Pay with ETH" checkout implements privately; `Status` is
`covered`, `partial`, or `not-covered`, and every `partial`/`not-covered` row carries
a reason and a phase pointer.

If something the Drops flow needs is genuinely not in v1, it is recorded here, not
buried in a plan's `SUMMARY.md` nobody reads at integration time.

| Drops module | What it did | SDK export that covers it | Status |
| --- | --- | --- | --- |
| `swap/swapQuoteMath.ts` | Reproduces the Router's buy/sell arithmetic in BigInt for SnF-native pools (9800/10000 net fee + royalty), so a mock checkout can quote the number the Router would return | `client.quoteBuy` / `client.quoteSell` (`packages/sdk/src/math/quoteMath.ts`, reconciled against a live on-chain read, never simulated) | covered |
| `swap/swapGuards.ts` | The three on-chain asserts (payer ownership, pool custody, wrapper identity) that run in the signature frame, shared by buy and sell | `plan.preflight()` (`packages/sdk/src/build/preflight.ts`) — one Multicall3 call, same four+one checks (adds a balance check and `WRONG_CHAIN`) | covered |
| `swap/swapConstants.ts` | Shared constants: `CAP_ROYALTY_FEE=false`, default slippage/deadline, `MAX_WHOLE_NFT_QUANTITY` (never sell the pool's last item) | `capRoyaltyFee=false` is pinned internally at every Router call site (SPEC prohibition #6/#7 — not partner-configurable, stronger than Drops' own constant); `BuildArgs.slippageBps`/`.deadline` (defaults 100 bps / now+20min, capped 1h); pool-floor enforced inside `quoteBuy`/`poolInventory` | covered |
| `swap/sellQuoteReads.ts` | Narrows the permissive multicall results both quote directions read, in one shared place | Folded into `client.quoteSell`'s own internal reads (`packages/sdk/src/quote/`) — not a separate export, since a partner never assembles the multicall itself | covered |
| `swap/buyDerivations.ts` | Pure derivations the checkout decides from — in particular, keeping the QUOTED count and the SIGNED count the same number (the CR-02 bug class) | `ExecutionPlan`'s `Step.quote`/`Step.bounds` are derived from the SAME re-quote `build()` performs internally — never from the caller-supplied `quote` argument's numbers (SPEC prohibition: never trust caller-supplied prices for `bounds`/`value`) | covered |
| `swap/describeSwapError.ts` | Turns a failed purchase (decoded revert → viem `shortMessage` → raw message → generic) into a sentence, with wallet-rejection treated as no-error | `describeError` / `SnfError` / `SNF_ERROR_CODES` (`USER_REJECTED` is its own code, never surfaced as a generic error panel) | covered |
| `swap/sellReceipt.ts` | Reads what a seller actually received from the WETH `Withdrawal` log (native sells emit no `Transfer`) | `client.parseReceipt` (`packages/sdk/src/receipt/parseReceipt.ts`) | covered |
| `swap/checkoutDispatch.ts` | Confirm/approve/retry/close — every transaction begins in a labelled click, never a watcher | `createCheckout`'s `next()` is the checkout state machine's ONE member that can return a `Step` to dispatch; watchers (`onReceipt`/`onRejected`) are structurally incapable of it (INV-17) | covered |
| `swap/useCheckoutSession.ts` | The checkout's state + watchers — stage machine, one dispatch site | `createCheckout` (core) / `useSnfCheckout` (React adapter) — same one-dispatch-site invariant, plus wagmi wiring | covered |
| `inventory/subgraphQueries.ts` | The pool-inventory GraphQL query string sent to the public index | Internal to `client.poolInventory`'s subgraph transport (`packages/sdk/src/transport/subgraph.ts`) — not exposed as a raw query string, since a partner never needs to hand-assemble GraphQL | covered |
| `inventory/useSubgraphInventory.ts` | React hook wrapping the inventory query with staleness/freshness sentences | `useSnfPoolInventory` (React adapter) → `PoolInventory.stale` / `.lagSeconds` / `.source` fields | covered |
| `inventory/tokenUriParse.ts` | Per-token artwork resolution via on-chain `tokenURI(id)` — no indexer, no marketplace API key, parses `data:`/`ipfs:`/`https:` schemes and the image-field precedence | none yet | **not-covered** — `CollectionInfo.labels.imageUrl` (`collection.types.ts`) is declared but never populated by `resolveCollection`; no per-token image resolution exists anywhere in `packages/sdk/src`. A partner building a token picker UI must implement their own `tokenURI` read today. Reason: this phase's `resolveCollection` (R6) scopes to collection-level identity only; per-token artwork was out of scope for SDK-0/SDK-1. Phase pointer: no phase currently owns this — flag for Phase 55 scoping (docs/site phase) or a future SDK-2 inventory-enrichment plan. |

## What this checklist does NOT cover (by design, not a gap)

Everything `54-SPEC.md`'s Boundaries section scopes out of this SDK entirely is
absent from this table on purpose, not because it was missed: liquidity (add/remove/
create pool — Phase 87), portfolio/LP position reads (Phase 88), the marketplace
aggregator (OpenSea/Seaport), Relay, sell-into-bids, Sweep & Bridge, Farm, Bridge, and
the SnF Advanced Router's atomic NFT×NFT contract. None of these exist in the Genesis
checkout either, so they have no corresponding row above.
