# @sweepnflip/widgets

A headless React kit — `SnfTradeCard` and `SnfPoolStats` — over `@sweepnflip/sdk` and
`@sweepnflip/sdk-react`. It renders and it dispatches through those two packages; it
contains no trading logic of its own — no arithmetic on an amount, no numeric
formatting, no contract read or write. Every number shown and every transaction sent
comes straight from the SDK.

`private: true`, consumed from a local checkout inside this monorepo. Publishing is a
separate, still-pending founder decision — the same one already deferred from Phase 54,
unchanged by this package becoming real.

An optional SnF theme will ship as a separate CSS entry point a partner imports only if
they want a working look on day one; not importing it leaves every part fully
functional and completely unstyled.

## Status

This package is under active construction (Phase 56). What exists today:

- The toolchain — a real, buildable, testable workspace member (this plan, snf-56-01).

What is still owed, and which plan lands it:

- `SnfTradeCard`, the compound component covering buy/sell/NFT×NFT (plan 05).
- `SnfPoolStats`, price/reserves/buyable-ceiling (plan 06).
- The theme's separate CSS entry point (plan 07).
- Internal primitives — compound-component context, styling helpers — that back both
  components (plan 03).

Until plan 05 lands, this package's public surface is a single placeholder export
(`SNF_WIDGETS_VERSION`) proving the build and test pipeline works end to end.
