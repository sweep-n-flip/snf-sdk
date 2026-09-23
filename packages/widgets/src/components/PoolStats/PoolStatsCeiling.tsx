import { cloneElement, type ReactElement, type ReactNode } from 'react'
import { mergeClassNames } from '../../internal/classNames'
import { toDataAttrs } from '../../internal/dataState'
import { Slot } from '../../internal/slot'
import { resolveErrorMessage } from '../../messages'
import { usePoolStatsContext } from './context'
import type { PoolStatsPartProps } from './PoolStats.types'

/**
 * `PoolStatsCeiling` — renders the buyable ceiling for this pool (R5).
 *
 * R5's literal acceptance criterion: the number shown is `inventory.data.
 * availableCount` READ DIRECTLY off the SDK's own `PoolInventory` — never a
 * client-side recomputation from the pool's raw wrapper-token reserve (this component
 * never divides that reserve by anything). `source`/`stale`/`lagSeconds` are rendered
 * alongside as supporting context, also
 * verbatim off the same `PoolInventory` value — a stale/degraded read is always
 * surfaced, never hidden.
 */
export function PoolStatsCeiling(props: PoolStatsPartProps): ReactNode {
  const ctx = usePoolStatsContext()
  const { inventory } = ctx

  const state: 'idle' | 'loading' | 'error' | 'ready' = inventory.isLoading
    ? 'loading'
    : inventory.error
      ? 'error'
      : inventory.data
        ? 'ready'
        : 'idle'

  const defaultContent: ReactNode = inventory.error ? (
    <span data-testid="ceiling-error" data-error-code={inventory.error.code}>
      {resolveErrorMessage(inventory.error.code, ctx.messages)}
    </span>
  ) : inventory.data ? (
    <>
      <span data-testid="ceiling-available-count">{inventory.data.availableCount}</span>
      <span data-testid="ceiling-source">{inventory.data.source}</span>
      <span data-testid="ceiling-stale">{inventory.data.stale ? 'stale' : 'fresh'}</span>
      <span data-testid="ceiling-lag-seconds">{inventory.data.lagSeconds}</span>
    </>
  ) : (
    <span data-testid="ceiling-available-count">—</span>
  )

  const overrideContent =
    typeof props.children === 'function' ? props.children(ctx) : props.asChild ? undefined : props.children
  const content = overrideContent ?? defaultContent

  const mergedClassName = mergeClassNames(props.className)
  const dataAttrs = toDataAttrs({ part: 'ceiling', state, stale: inventory.data?.stale ?? false })

  if (props.asChild) {
    const slotProps = { ...dataAttrs, ...(mergedClassName === undefined ? {} : { className: mergedClassName }) }
    // See `PoolStatsPrice.tsx`'s header comment — same content-injection pattern, not
    // a re-implementation of `Slot`'s own attrs/className/ref merge logic.
    const substituted = cloneElement(props.children as ReactElement, undefined, content)
    return <Slot {...slotProps}>{substituted}</Slot>
  }

  return (
    <div className={mergedClassName} {...dataAttrs}>
      {content}
    </div>
  )
}
