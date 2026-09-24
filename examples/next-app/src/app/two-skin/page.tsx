import type { Metadata } from 'next'
import { TwoSkinDemo } from '../../components/TwoSkinDemo'

export const metadata: Metadata = {
  title: 'Two skins, one component — @sweepnflip/widgets example',
  description:
    'Proof surface: SnfTradeCard rendered twice on one page, once wrapped in the SnF ' +
    'theme, once styled by an independent, hand-authored "partner" stylesheet, both driven by ' +
    'identical props.',
}

export default function TwoSkinPage() {
  return (
    <main style={{ maxWidth: 900, margin: '0 auto' }}>
      <h1>Two skins, one component</h1>
      <p style={{ opacity: 0.7 }}>
        <code>SnfTradeCard</code> rendered twice below, fed the SAME collection/count/recipient
        props — once wrapped in the SnF theme (<code>@sweepnflip/widgets/theme.css</code>, opted
        in via a <code>data-snf-theme</code> ancestor), once with a deliberately different,
        hand-authored &quot;partner&quot; skin sharing no CSS with the theme. Appearance differs
        completely; the underlying SDK calls each instance makes do not — see{' '}
        <code>packages/widgets/test/twoSkin.test.tsx</code> for the behavioural proof.
      </p>
      <TwoSkinDemo />
    </main>
  )
}
