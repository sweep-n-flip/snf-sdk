'use client'

import nextDynamic from 'next/dynamic'

// This whole page is wallet/RPC-driven client state (wagmi + react-query useQuery
// hooks). Rendered on the server, `SwapPanel`'s hooks reach for `useQueryClient()`
// before Next's SSR pass has the ancestor `<Providers>` tree fully reconciled for a
// `force-dynamic` route — a Next App Router / react-query SSR interaction, not
// anything specific to this SDK. `ssr: false` sidesteps it entirely: this content has
// nothing meaningful to server-render anyway (it depends on a connected wallet and
// live on-chain reads), so it mounts client-side only, same as the rest of this page.
const SwapPanel = nextDynamic(() => import('../components/SwapPanel').then((mod) => mod.SwapPanel), {
  ssr: false,
})

export default function HomePage() {
  return (
    <main style={{ maxWidth: 640, margin: '0 auto' }}>
      <h1>Sweep n&apos; Flip SDK — reference wiring</h1>
      <p style={{ opacity: 0.7 }}>
        Discovery → inventory → quote → checkout, through <code>@sweepnflip/sdk-react</code>
        &apos;s public hooks only — no RainbowKit, no other product&apos;s checkout code. This page
        is a wiring reference, not a product; a partner&apos;s real UI is their own.
      </p>
      <SwapPanel />
    </main>
  )
}
