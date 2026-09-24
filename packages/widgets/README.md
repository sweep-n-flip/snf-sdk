# SnF widgets

A headless React kit — `SnfTradeCard` and `SnfPoolStats` — over `@sweepnflip/sdk` and
`@sweepnflip/sdk-react`. It renders and it dispatches through those two packages; it
contains no trading logic of its own — no arithmetic on an amount, no numeric
formatting, no contract read or write. Every number shown and every transaction sent
comes straight from the SDK.

## Install — copy the source

The kit is **not a registry package**. It is distributed as source: you copy it into
your app and own every file, so you can restyle or edit anything.

```sh
pnpm add @sweepnflip/sdk @sweepnflip/sdk-react viem wagmi @tanstack/react-query
npx degit sweep-n-flip/snf-sdk/packages/widgets/src src/snf-widgets
```

Any destination folder works. The copied files import only React, `@tanstack/react-query`
and the two SDK packages above.

```tsx
import { SnfTradeCard, SnfPoolStats } from './snf-widgets'
```

## Styling

Three mechanisms, all optional: `className` on every part (merged with ours), `data-*`
state attributes to target in your own CSS, and `asChild` to render your own element in
place of ours. Full reference: https://app.sweepnflip.io/docs/sdk/widgets

## Optional theme

`theme.css`, at the root of the copied folder, ships the SnF look as overridable CSS
custom properties — import it only if you want a working look on day one; not
importing it leaves every part fully functional and completely unstyled. The theme is a
single opt-in **per surface**, not a page-wide hijack: importing the stylesheet alone
styles nothing — every component rule is nested under the `[data-snf-theme]` ancestor
selector, so it only applies once you also add a `data-snf-theme` attribute on some
ancestor element:

```tsx
import './snf-widgets/theme.css'

// Themed
<div data-snf-theme>
  <SnfTradeCard.Root ...>...</SnfTradeCard.Root>
</div>

// Unstyled, or styled by your own CSS — same import, no data-snf-theme
<SnfTradeCard.Root ...>...</SnfTradeCard.Root>
```

This is what lets you render one themed instance and one independently-skinned
instance (your own design system) on the same page, sharing the one imported
stylesheet but not its rules.

## This folder

`package.json`, `tsup.config.ts` and `test/` exist so the kit is built, type-checked and
tested in this monorepo like the other packages. The package is `private: true` and is
never published; only `src/` is meant to be copied.
