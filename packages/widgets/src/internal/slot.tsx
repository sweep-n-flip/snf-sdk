import {
  cloneElement,
  forwardRef,
  isValidElement,
  type ForwardRefExoticComponent,
  type ReactElement,
  type Ref,
  type RefAttributes,
} from 'react'
import { mergeClassNames } from './classNames'
import type { SlotProps } from './slot.types'

/**
 * `Slot` — the hand-written `asChild` primitive (D-04, D-05, R6). No headless-UI
 * library import anywhere in this file or this package — this IS the payoff of that
 * constraint. No browser-only API is used here (pure prop-merging), so no
 * `'use client'` directive is added: this component is a plain `cloneElement` call,
 * safe in a server or client tree either way, and adding a client directive would
 * force every consumer into a client bundle for no reason.
 *
 * Renders NO DOM node of its own: it clones the single child element the caller
 * substituted and merges this component's own props onto it. This is what
 * "substitutes the partner's own element" means literally — there is never a wrapper
 * `<span>`/`<div>` between the kit's behaviour and the partner's markup.
 *
 * Merge order (T-56-05 — Slot must merge, never silently drop, either side's props):
 *   - `className`: `mergeClassNames(ownClassName, childClassName)` — the CHILD's
 *     value is passed SECOND, so the partner's own class (present on the element they
 *     substituted) is concatenated after the kit's and never dropped.
 *   - every other own prop except `className`/`children`: spread FIRST, then the
 *     CHILD's own matching props spread OVER them — an event handler or attribute the
 *     partner's own element explicitly sets is never silently replaced by the kit's.
 *   - `ref`: composed via `composeRefs` so both the forwarded ref and the child's own
 *     ref (if any) are called — the child's own ref is never dropped. React 19 carries
 *     `ref` as a regular member of `element.props` (the legacy separate `element.ref`
 *     field was removed), so it is read from `children.props.ref` like any other prop.
 *
 * Implementation note: `forwardRef`'s own `PropsWithoutRef<P>` helper collapses any
 * props type that carries a blanket string index signature (as `SlotProps` does, by
 * design — every part passes arbitrary `data-*`/ARIA/event props through `Slot`) down
 * to a bare index-signature type, silently losing the `children`/`className` members
 * — a known TypeScript limitation (microsoft/TypeScript#28339, cited in React's own
 * `PropsWithoutRef` doc comment). `forwardRef` is therefore invoked against the plain
 * `Record<string, unknown>` shape it can actually reason about; the single exported
 * `Slot` binding is cast ONE time, at this module's only public seam, back to the
 * precise `SlotProps` signature every caller and later plan actually imports — never
 * `any`, and no other cast in this file depends on it.
 */
const SlotImpl = forwardRef<HTMLElement, Record<string, unknown>>(function Slot(rawProps, forwardedRef) {
  const { children: rawChildren, className: rawClassName, ...rest } = rawProps

  // Narrow cast (never `any`, per CLAUDE.md): declares what shape `rawChildren` is
  // expected to be BEFORE the runtime `isValidElement` check verifies it, so the check
  // itself narrows away `null`/`undefined` rather than merely asserting a shape with
  // no verification at all.
  const maybeChild = rawChildren as ReactElement<Record<string, unknown>> | null | undefined

  if (!isValidElement<Record<string, unknown>>(maybeChild)) {
    throw new Error('Slot requires a single valid React element child (asChild=true).')
  }

  const children = maybeChild
  const className = typeof rawClassName === 'string' ? rawClassName : undefined
  const childProps = children.props
  const childClassName = typeof childProps.className === 'string' ? childProps.className : undefined
  const childRef = toRef(childProps.ref)

  const merged: Record<string, unknown> = {
    ...rest,
    ...childProps,
    className: mergeClassNames(className, childClassName),
    ref: composeRefs(forwardedRef, childRef),
  }

  return cloneElement(children, merged as Partial<Record<string, unknown>>)
})

/** Cast ONE time at this module's only public seam — see the header comment above for
 * why `forwardRef`'s own generic can't carry `SlotProps` directly. `ForwardRefExoticComponent`
 * + `RefAttributes` is the exact type `React.forwardRef` itself would produce were it
 * able to see `SlotProps` precisely, so `<Slot ref={...}>` still type-checks for
 * callers exactly as it would without this cast. */
export const Slot = SlotImpl as unknown as ForwardRefExoticComponent<SlotProps & RefAttributes<HTMLElement>>

/** Narrow runtime check + cast turning an unknown prop value into a `Ref<HTMLElement>`
 * when it is genuinely ref-shaped (a callback, or an object carrying `current`) —
 * never `any`. Anything else (including `undefined`/`null`) yields `undefined`, which
 * `composeRefs` already treats as "nothing to compose here". */
function toRef(value: unknown): Ref<HTMLElement> | undefined {
  if (typeof value === 'function') return value as Ref<HTMLElement>
  if (value !== null && typeof value === 'object' && 'current' in value) {
    return value as Ref<HTMLElement>
  }
  return undefined
}

/** Calls every supplied ref (callback or object form) with the same node, so a
 * forwarded ref and a substituted child's own ref both observe the mounted element —
 * neither is ever silently dropped (T-56-05). */
function composeRefs<T>(...refs: ReadonlyArray<Ref<T> | undefined>): Ref<T> {
  return (node: T | null) => {
    for (const ref of refs) {
      if (typeof ref === 'function') {
        ref(node)
      } else if (ref) {
        ref.current = node
      }
    }
  }
}
