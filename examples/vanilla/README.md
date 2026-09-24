# `@sweepnflip/sdk` — vanilla Node example

## What it proves

`@sweepnflip/sdk`'s core is genuinely framework-agnostic: this
script runs on bare Node.js with **only `viem` as a peer** — `react`, `react-dom`,
`wagmi` and `@tanstack/react-query` do not exist anywhere in this example's own
`package.json`, and `pnpm --filter @sweepnflip/example-vanilla list --depth 10` finds
none of those names transitively either. If the core ever grew a React import, this
example's install (or its `list --depth 10` check) would break — that is the whole
point of shipping it as a compile-time contract, not documentation that can drift.

It walks the exact call sequence a partner integrates: `createSnfClient` → discover a
collection → read its pool's candidate inventory → quote a buy → build a plan →
pre-flight it — against the real, live Base ETH/DEMON pool (no mocks, no fixtures),
and prints the reconciled fee breakdown this rule's two-field `{ value, formatted }` money
convention produces. This is the exact sequence the root README's `## Quickstart`
shows — a test (`packages/sdk/test/release/surface.test.ts`) asserts the two have not
drifted apart.

`buildBuy` and `plan.preflight()` are BOTH read-only — `buildBuy` re-quotes on-chain
and computes unsigned calldata, `preflight()` is one Multicall3 read — neither needs a
private key or a signer, which is why this script can demonstrate the full sequence up
to (but never including) the actual send. Set `RECIPIENT_ADDRESS` to the wallet that
will sign and pay: it is the payer, the signer and the receiver at once, so pre-flight
checks its balance. Without it the script stops after the quote.

## How to run it

```sh
pnpm -C examples/vanilla start
# or, from this folder:
node src/index.mjs
```

No wallet, no private key, no API key and no SnF server are required — every call this
script makes (the quote, `buildBuy`, `plan.preflight()`) is a read against a public
Base RPC; nothing is ever signed or sent. Override the RPC with `BASE_RPC_URL` if you
have your own (e.g. an Alchemy/Infura endpoint); the SDK itself never reads
`process.env` — only this example script does, for its own transport setup.

> The default RPC is `https://base-rpc.publicnode.com`, not the chain registry's
> listed `defaultRpcUrl` (`mainnet.base.org`) — the latter's free tier started
> returning HTTP 429s under this script's handful of sequential multicalls
> (`collection` → `poolInventory` → `quoteBuy`, each issuing its own on-chain read)
> during verification. `publicnode`'s mirror answered every attempt cleanly. Both are
> public, keyless Base RPCs; either works for a partner with their own rate limits.

## Example output

Captured from a real run against Base mainnet (2026-09-21):

```
Sweep n' Flip — buy 3 DEMON from pool 0xE8143126bdFBe58ED0056f88031236766C311ECf

pool         bps=200 (included in curve)
marketplace  0.00001117 ETH  (value=11175643448620n)
royalty      0.00002235 ETH  (value=22351286897241n)
gross        0.00048 ETH  (value=480552668290683n)
deliverable  3
bestEffort   false
priceImpact  36.5
reconciled: true

plan ready: 1 step(s) (swap-buy)
send each step in plan.steps with your own wallet — one click per step (see examples/next-app)
```

Every fee amount is printed both `formatted` (for display) and as its raw `value`
`bigint` (what a real transaction would actually use) — this rule's convention: never parse
`formatted` back for math, `value` is always the exact figure.

If the quote does not reconcile against the Router's own on-chain read, the SDK never
returns a `Quote` object at all — it throws `SnfError('QUOTE_RECONCILIATION_FAILED')`
instead (see `errors.types.ts`), which this script's `try/catch` runs through
`describeError` and reports on exit code 1, the same way it reports any other failure
(a stale RPC, an emptied pool, a wallet-side RPC auth issue). There is no code path
that prints a `Quote` whose `reconciled` field is anything other than `true`.
