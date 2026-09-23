import type { Ref } from 'react'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Slot } from '../src/internal/slot'
import { toDataAttrs } from '../src/internal/dataState'

/**
 * Primitive-level proof of R6's three independent styling mechanisms (D-05):
 *   (a) a bare render carries no `style` attribute and no color/size/spacing/font-
 *       shaped attribute — nothing visual is baked in;
 *   (b) a merged `className` where the caller's own class survives verbatim alongside
 *       the kit's own class;
 *   (c) `asChild` substitution via `Slot`, proven to clone rather than wrap (exactly
 *       one DOM node, the partner's own element type, carrying the merged className).
 * A fourth test proves `toDataAttrs` never emits a color/size/spacing/font-shaped
 * value. Uses a tiny local test component, not a real widgets part (none exist yet).
 */

const CSS_UNIT_SHAPED = /^-?\d+(\.\d+)?(px|rem|em|%)$/
const HEX_COLOR_SHAPED = /^#/

interface TestPartProps {
  readonly className?: string
}

/** A minimal stand-in for a real headless "part" — renders its own `<div>`, own
 * `kit-class`, and forwards any caller-supplied `className` through `mergeClassNames`
 * indirectly via string concatenation is NOT done here on purpose: this test asserts
 * the merge happens via `Slot`'s own logic for the `asChild` case, and via a plain
 * template join for the "no asChild" case, matching how a real part would call
 * `mergeClassNames` itself (Task 1 does not require a second component under test —
 * the merge implementation under test in both (a)/(b) is the component's own use of
 * string values, in (c) it is `Slot`'s). */
function TestPart({ className }: TestPartProps) {
  const merged = [`kit-class`, className].filter(Boolean).join(' ')
  return <div data-testid="x" className={merged} />
}

describe('styling mechanism (a): bare render carries nothing visual', () => {
  it('has no style attribute and no color/size/spacing/font-shaped attribute value', () => {
    render(<TestPart />)
    const node = screen.getByTestId('x')

    expect(node.getAttribute('style')).toBeNull()
    expect(node.className).toBe('kit-class')

    for (const attr of Array.from(node.attributes)) {
      expect(attr.value).not.toMatch(CSS_UNIT_SHAPED)
      expect(attr.value).not.toMatch(HEX_COLOR_SHAPED)
    }
  })
})

describe('styling mechanism (b): className merge — partner class survives', () => {
  it('renders both the kit class and the partner class on the same element', () => {
    render(<TestPart className="partner-class" />)
    const node = screen.getByTestId('x')

    expect(node.className).toContain('kit-class')
    expect(node.className).toContain('partner-class')
  })
})

describe('styling mechanism (c): asChild substitution via Slot — clone, not wrap', () => {
  interface PartnerButtonProps {
    readonly ref?: Ref<HTMLButtonElement>
    readonly className?: string
    readonly [key: string]: unknown
  }

  // React 19 function components accept `ref` as a regular prop — no `forwardRef`
  // wrapper needed. A real partner component forwards whatever it doesn't recognise
  // onto its own DOM node — this is what proves Slot's own props (e.g. a
  // kit-supplied `data-*` attribute) actually reach the substituted element.
  function PartnerButton({ ref, className, ...rest }: PartnerButtonProps) {
    return <button ref={ref} type="button" className={className} data-testid="partner-button" {...rest} />
  }

  it('renders exactly one DOM node — the partner element, not a wrapper', () => {
    const { container } = render(
      <Slot className="kit-class" data-kit-marker="present">
        <PartnerButton className="partner-button" />
      </Slot>,
    )

    // Exactly one child of the render root, and it is a real <button>.
    expect(container.children).toHaveLength(1)
    const node = screen.getByTestId('partner-button')
    expect(node.tagName).toBe('BUTTON')
  })

  it('merges the kit className with the partner own className, both surviving', () => {
    render(
      <Slot className="kit-class">
        <PartnerButton className="partner-button" />
      </Slot>,
    )
    const node = screen.getByTestId('partner-button')

    expect(node.className).toContain('kit-class')
    expect(node.className).toContain('partner-button')
  })

  it('passes through a kit-supplied data-* prop onto the substituted element', () => {
    render(
      <Slot className="kit-class" data-kit-marker="present">
        <PartnerButton className="partner-button" />
      </Slot>,
    )
    const node = screen.getByTestId('partner-button')

    expect(node.getAttribute('data-kit-marker')).toBe('present')
  })

  it('throws a clear error when the child is not a single valid React element', () => {
    // React surfaces render-time errors as console.error + a thrown error; suppress
    // the expected console noise for this one assertion.
    const originalError = console.error
    console.error = () => {}
    try {
      expect(() =>
        render(
          // @ts-expect-error — deliberately violating Slot's own contract to prove it throws.
          <Slot className="kit-class">{'not an element'}</Slot>,
        ),
      ).toThrow('Slot requires a single valid React element child (asChild=true).')
    } finally {
      console.error = originalError
    }
  })
})

describe('toDataAttrs never emits a color/size/spacing/font-shaped value', () => {
  it('produces only the exact strings supplied, never a CSS-unit or hex-color shape', () => {
    const attrs = toDataAttrs({ part: 'root', state: 'ready-approve', busy: false })

    expect(attrs).toEqual({ 'data-part': 'root', 'data-state': 'ready-approve', 'data-busy': 'false' })

    for (const value of Object.values(attrs)) {
      expect(value).not.toMatch(CSS_UNIT_SHAPED)
      expect(value).not.toMatch(HEX_COLOR_SHAPED)
    }
  })

  it('drops keys whose value is undefined', () => {
    const attrs = toDataAttrs({ part: 'root', side: undefined })
    expect(attrs).toEqual({ 'data-part': 'root' })
    expect('data-side' in attrs).toBe(false)
  })
})
