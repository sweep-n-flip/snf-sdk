'use client'

// A single, module-top-level side-effect import applies to this WHOLE module (not
// per-instance) — importing it here does not, by itself, style anything (R7's
// 2026-09-23 amendment): every rule inside `theme.css` is nested under the
// `[data-snf-theme]` opt-in ancestor selector. Only the wrapper below that actually
// carries the `data-snf-theme` attribute picks up the look.
import '@sweepnflip/widgets/theme.css'

import type { CSSProperties } from 'react'
import { useAccount, useConnect, useDisconnect } from 'wagmi'
import { SnfTradeCard } from '@sweepnflip/widgets'

/**
 * examples/next-app/src/components/TwoSkinDemo.tsx
 *
 * R12's proof surface: `<SnfTradeCard.Root>` rendered TWICE on one page, fed the
 * SAME `collection`/`count`/`recipient` props, wearing two skins that share NOTHING:
 *
 *   1. **SnF-themed instance** — wrapped in a single `data-snf-theme` ancestor `<div>`.
 *      No `className` prop appears anywhere on this instance's parts; the theme's own
 *      `[data-snf-theme] [data-part="..."]` rules (imported once, above) do all the
 *      work.
 *   2. **Partner-skinned instance** — no `data-snf-theme` anywhere. Styled entirely by
 *      `PARTNER_SKIN_CSS` below, a small hand-authored inline stylesheet (this
 *      phase's toolchain forbids adding CSS tooling as an eleventh dependency) scoped
 *      to a distinct wrapper class, `.partner-skin`, and applied via `className`
 *      props passed directly to `Root`/`Input`/`QuoteBreakdown`/`Steps`/`Action`.
 *      `PARTNER_SKIN_CSS` shares ZERO selectors and ZERO `--snf-*` custom-property
 *      names with `theme.css` — a completely independent stylesheet, standing in for
 *      "a partner's own design system."
 *
 * Both instances share the ONE `SnfProvider`/wallet connection this page's ancestor
 * `<Providers>` already mounts (`app/providers.tsx`) — proving STYLE independence,
 * not a second wallet/provider setup. `ConnectRow` below is copied field-for-field
 * from `SwapPanel.tsx`'s own connect UI (the same discipline: `next()`/`connect()`
 * only ever fire from an explicit `onClick`, never a `useEffect`).
 */

// The Base ETH/DEMON pool this monorepo's own fixtures pin down — the SAME real,
// live collection `SwapPanel.tsx` defaults to, so both instances below show real
// numbers on first load.
const COLLECTION = '0x7e50af303A0422ebec6bc198034A2430bBe0195c' as const
const COUNT = 1

// Deliberately shares zero class names and zero `--snf-*` custom-property names with
// `packages/widgets/src/theme.css` — an entirely independent stylesheet standing in
// for "a partner's own design system." Every selector below is scoped under
// `.partner-skin`, the wrapper class the second column's outer `<div>` carries.
const PARTNER_SKIN_CSS = `
.partner-skin .partner-root {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 22px;
  border: 3px dashed #f59e0b;
  border-radius: 0;
  background: #1c1917;
  color: #fef3c7;
  font-family: Georgia, 'Times New Roman', serif;
}
.partner-skin .partner-input {
  font-size: 1.35rem;
  letter-spacing: 0.04em;
  color: #fbbf24;
}
.partner-skin .partner-quote {
  font-size: 0.78rem;
  color: #d6d3d1;
}
.partner-skin .partner-steps {
  list-style: upper-roman;
  padding-left: 22px;
  margin: 0;
}
.partner-skin .partner-steps li {
  padding: 3px 0;
  color: #e7e5e4;
}
.partner-skin .partner-action {
  padding: 12px 30px;
  border: 3px solid #f59e0b;
  border-radius: 0;
  background: transparent;
  color: #f59e0b;
  font-family: Georgia, 'Times New Roman', serif;
  font-weight: bold;
  text-transform: uppercase;
  cursor: pointer;
}
.partner-skin .partner-action:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
`

const columnStyle: CSSProperties = { flex: '1 1 320px', minWidth: 280 }
const sectionNoteStyle: CSSProperties = { opacity: 0.7, fontSize: 13, marginBottom: 12 }

function ConnectRow() {
  const { address, isConnected } = useAccount()
  const { connect, connectors, isPending } = useConnect()
  const { disconnect } = useDisconnect()

  if (isConnected && address) {
    return (
      <div style={{ marginBottom: 24 }}>
        <span>Connected: {address}</span>
        <button style={{ marginLeft: 12 }} onClick={() => disconnect()}>
          Disconnect
        </button>
      </div>
    )
  }

  const injectedConnector = connectors.find((c) => c.id === 'injected')

  return (
    <div style={{ marginBottom: 24 }}>
      <button
        disabled={!injectedConnector || isPending}
        onClick={() => injectedConnector && connect({ connector: injectedConnector })}
      >
        {isPending ? 'Connecting…' : 'Connect wallet'}
      </button>
    </div>
  )
}

export function TwoSkinDemo() {
  const { address } = useAccount()
  const recipient = address

  return (
    <div>
      <ConnectRow />
      <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap' }}>
        <div style={columnStyle}>
          <h2>SnF theme</h2>
          <p style={sectionNoteStyle}>
            Wrapped in a single <code>data-snf-theme</code> ancestor — that attribute is the
            ONLY thing opting this surface into `theme.css`&apos;s rules (imported once, at
            this file&apos;s top). No <code>className</code> prop appears on any part below.
          </p>
          <div data-snf-theme>
            <SnfTradeCard.Root side="buy" collection={COLLECTION} count={COUNT} recipient={recipient}>
              <SnfTradeCard.Input />
              <SnfTradeCard.QuoteBreakdown />
              <SnfTradeCard.Steps />
              <SnfTradeCard.Action />
            </SnfTradeCard.Root>
          </div>
        </div>

        <div style={columnStyle} className="partner-skin">
          <h2>Partner skin</h2>
          <p style={sectionNoteStyle}>
            No <code>data-snf-theme</code> anywhere — styled entirely by this page&apos;s own
            hand-authored CSS below (<code>PARTNER_SKIN_CSS</code>), sharing no class name or{' '}
            <code>--snf-*</code> token with `theme.css`. Stands in for &quot;a partner&apos;s own
            design system.&quot;
          </p>
          {/* A small, page-scoped inline stylesheet standing in for a partner's own CSS
              pipeline — this phase's toolchain forbids adding CSS tooling as an eleventh
              dependency, so a real `<style>` element (not `dangerouslySetInnerHTML`, not
              a CSS-in-JS library) is the plain, dependency-free way to scope it. */}
          <style>{PARTNER_SKIN_CSS}</style>
          <SnfTradeCard.Root
            side="buy"
            collection={COLLECTION}
            count={COUNT}
            recipient={recipient}
            className="partner-root"
          >
            <SnfTradeCard.Input className="partner-input" />
            <SnfTradeCard.QuoteBreakdown className="partner-quote" />
            <SnfTradeCard.Steps className="partner-steps" />
            <SnfTradeCard.Action className="partner-action" />
          </SnfTradeCard.Root>
        </div>
      </div>
    </div>
  )
}
