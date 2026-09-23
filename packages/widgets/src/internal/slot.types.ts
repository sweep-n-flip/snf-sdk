import type { ReactElement } from 'react'

/**
 * `AsChildProps` — every public part's own props type extends this one (D-04, R6).
 * When a part receives `asChild={true}`, it renders no DOM node of its own: it hands
 * its own merged props to `Slot`, which clones the caller's single substituted child
 * instead of wrapping it in an extra element. When `asChild` is absent or `false`
 * (the default), the part renders its own normal element. This type carries no
 * behaviour itself — it exists so every part's props type documents the same contract
 * in one place rather than re-declaring `asChild?: boolean` independently per part.
 */
export interface AsChildProps {
  readonly asChild?: boolean
}

/**
 * `Slot`'s own public props. `children` MUST be a single, valid React element (never
 * text, an array, `null`, or a fragment) — `slot.tsx` throws a clear error otherwise.
 * Every other own key (including `data-*`/ARIA/event props a calling part passes
 * through) is merged onto that element; see `slot.tsx`'s header comment for the exact
 * per-key merge order.
 */
export type SlotProps = {
  readonly children: ReactElement
  readonly className?: string
} & Readonly<Record<string, unknown>>
