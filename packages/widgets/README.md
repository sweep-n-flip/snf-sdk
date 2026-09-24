# @sweepnflip/widgets

A headless React kit — `SnfTradeCard` and `SnfPoolStats` — over `@sweepnflip/sdk` and
`@sweepnflip/sdk-react`. It renders and it dispatches through those two packages; it
contains no trading logic of its own — no arithmetic on an amount, no numeric
formatting, no contract read or write. Every number shown and every transaction sent
comes straight from the SDK.

`private: true`, consumed from a local checkout inside this monorepo. Publishing this
package to npm is a separate decision, made independently of when it becomes feature-complete.

An optional SnF theme ships as a separate CSS entry point, `@sweepnflip/widgets/theme.css`
— import it only if you want a working look on day one; not importing it leaves every
part fully functional and completely unstyled. The theme is a single opt-in **per
surface**, not a page-wide hijack: importing the stylesheet alone styles nothing — every
component rule is nested under the `[data-snf-theme]` ancestor selector, so it only
applies once you also add a `data-snf-theme` attribute on some ancestor element. One
import, plus `data-snf-theme` on a wrapper around the surface you want themed (or on
`<body>` to opt the whole page in):

```tsx
import '@sweepnflip/widgets/theme.css'

// Themed
<div data-snf-theme>
  <SnfTradeCard.Root ...>...</SnfTradeCard.Root>
</div>

// Unstyled, or styled by the partner's own CSS — same import, no data-snf-theme
<SnfTradeCard.Root ...>...</SnfTradeCard.Root>
```

This is what lets a partner render one themed instance and one independently-skinned
instance (their own design system) on the same page, sharing the one imported
stylesheet but not its rules.

## Status

This package is under active construction. What exists today:

- The toolchain — a real, buildable, testable workspace member.

What is still owed:

- `SnfTradeCard`, the compound component covering buy/sell/NFT×NFT.
- `SnfPoolStats`, price/reserves/buyable-ceiling.
- The theme's separate CSS entry point.
- Internal primitives — compound-component context, styling helpers — that back both
  components.

Until those land, this package's public surface is a single placeholder export
(`SNF_WIDGETS_VERSION`) proving the build and test pipeline works end to end.
