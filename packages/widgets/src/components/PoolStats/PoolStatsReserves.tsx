import { cloneElement, type ReactElement, type ReactNode } from 'react'
import { mergeClassNames } from '../../internal/classNames'
import { toDataAttrs } from '../../internal/dataState'
import { Slot } from '../../internal/slot'
import { resolveErrorMessage } from '../../messages'
import { usePoolStatsContext } from './context'
import type { PoolStatsPartProps } from './PoolStats.types'

/**
 * `PoolStatsReserves` — renders this pool's raw reserves as plain text (R9).
 *
 * `.toString()`-only, exactly like `examples/next-app`'s own `InventorySection`
 * renders `asOfBlock.toString()`: `pool.reserves.base`/`pool.reserves.wnft` are raw
 * wei-shaped `bigint`s, printed verbatim, never divided and never passed through a
 * numeric-formatting call. No pool yet (`pool === undefined`) renders an honest empty
 * state, never a fabricated `0`.
 */
export function PoolStatsReserves(props: PoolStatsPartProps): ReactNode {
  const ctx = usePoolStatsContext()
  const { pool, collectionInfo } = ctx

  const state: 'idle' | 'loading' | 'error' | 'ready' = collectionInfo.isLoading
    ? 'loading'
    : collectionInfo.error
      ? 'error'
      : collectionInfo.data
        ? 'ready'
        : 'idle'

  const defaultContent: ReactNode = collectionInfo.error ? (
    <span data-testid="reserves-error" data-error-code={collectionInfo.error.code}>
      {resolveErrorMessage(collectionInfo.error.code, ctx.messages)}
    </span>
  ) : pool === undefined ? (
    <>
      <span data-testid="reserves-base">—</span>
      <span data-testid="reserves-wnft">—</span>
    </>
  ) : (
    <>
      <span data-testid="reserves-base">
        {pool.reserves.base.toString()} {pool.baseToken.symbol}
      </span>
      <span data-testid="reserves-wnft">
        {pool.reserves.wnft.toString()} {collectionInfo.data?.labels.symbol}
      </span>
    </>
  )

  const overrideContent =
    typeof props.children === 'function' ? props.children(ctx) : props.asChild ? undefined : props.children
  const content = overrideContent ?? defaultContent

  const mergedClassName = mergeClassNames(props.className)
  const dataAttrs = toDataAttrs({ part: 'reserves', state })

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
