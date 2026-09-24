# Security policy

`@sweepnflip/sdk` and `@sweepnflip/sdk-react` are client-direct packages: they talk to a
chain (via the partner's own `viem` `PublicClient`) and to the public SnF subgraph, and
they hand back **unsigned** calldata. Four things are non-negotiable, in every version,
on every chain:

1. **This SDK never signs.** No private key, no seed phrase, no signer object is ever
   accepted, stored, or touched by any function in either package. Every `ExecutionPlan`
   this package produces is unsigned calldata (`Step.tx`) — the caller's own wallet
   (`walletClient.sendTransaction`, wagmi's `useSendTransaction`, etc.) is the only thing
   that ever signs anything.
2. **This SDK never relays.** There is no SnF-operated server in the transaction path —
   no relayer, no meta-transaction forwarder, no gasless-tx sponsor. A partner's own RPC
   and the chain's own mempool are the only path a transaction takes.
3. **This SDK never custodies.** No user funds, no NFTs, no approvals are ever held by
   this package or by any address it controls. Every allowance/approval `Step` targets
   the SnF Router directly (`packages/sdk/src/abis`) — never an SDK-owned contract or
   wallet.
4. **This SDK never reads `process.env` at runtime.** Every value that affects a
   transaction — RPC endpoint, chain id, provider API keys — is supplied by the caller
   through `createSnfClient(...)`'s config object. The one exception is the example
   scripts under `examples/`, which are partner-facing demos, not package code — the
   grep gate below scans `packages/*/src` and `packages/*/dist` only, on purpose.

## How each is enforced

- `packages/sdk/eslint-rules` ships a custom lint rule
  (`local/no-signing-imports`) that fails the build if `packages/*/src` ever imports a
  private-key/signing utility (viem's `privateKeyToAccount`, `mnemonicToAccount`, etc.).
- `packages/sdk/test/prohibitions/no-signing-surface.test.ts` statically asserts the
  built public surface exposes no `sign*`/`send*`-shaped export that could be mistaken
  for a signing entry point, and that no test fixture ever constructs a real account
  from a private key.
- `scripts/grep-gate.mjs` (`pnpm grep:gate`) scans `packages/*/src` and `packages/*/dist`
  for `process.env`, `NEXT_PUBLIC_`, a hardcoded `sweepnflip.io`/`alchemy.com`/
  `opensea.io`/`coingecko.com` host, and any import of the founder's private production
  client — none of which a
  partner-facing package has a legitimate reason to contain.
- `scripts/release-gate.mjs` (`pnpm release:gate`) adds a secrets scan (64-hex
  literals, PEM private-key headers, `sk_live`/`snf_live_` prefixes, long-path indexer
  URLs, tracked `.env` files) over the whole repository and over both packages' built
  `dist`, so a secret cannot survive into a published tarball even if it slipped past
  code review.

## What a partner is responsible for

- **Their own RPC.** This SDK takes a `PublicClient` the caller constructs and never
  ships a default, key-bearing endpoint.
- **Their own wallet stack.** Connecting a wallet, prompting for signatures, and
  broadcasting the signed transaction are entirely the partner's own `viem`/wagmi setup.
  `@sweepnflip/sdk-react`'s `useSnfCheckout` is a thin driver over wagmi's own
  `useSendTransaction` — it never substitutes for it.
- **Their own keyed data providers**, if they choose to use one (e.g. a paid indexer for
  wallet-NFT enrichment). `createSnfClient({ providers: {...} })` accepts these as
  caller-supplied objects; the SDK ships no default that requires a key, and this
  package never proxies or stores a partner's key.

## The fence is the contract, not the SDK

Copying, forking, or editing this SDK does not avoid the marketplace fee or the
creator royalty. Both are charged by the SnF Router **on-chain**, computed from the
Router's own `marketplaceFee()` and EIP-2981 `royaltyInfo()` reads at the moment a swap
executes — this package only reads and reconstructs what the Router will charge; it has
no way to change it, and neither does anyone who edits a local copy of this source.
Logic that would ever be worth protecting from a hostile fork (best-execution routing,
multipool splitting) is planned to live behind the SnF REST `/v1` API, with
this SDK as a thin transport over it — never behind client-side obfuscation.

## Reporting a vulnerability

Open a private security advisory on the `sweep-n-flip/snf-sdk` GitHub repository
(Security tab → "Report a vulnerability") once the repository is public. Until
then, report directly to the founder through the existing SnF channels. Please do not
open a public issue for a vulnerability that could put live funds at risk before it has
been triaged.
