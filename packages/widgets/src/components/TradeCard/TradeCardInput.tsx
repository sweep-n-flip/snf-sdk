import { cloneElement, type ReactElement, type ReactNode } from 'react'
import { mergeClassNames } from '../../internal/classNames'
import { toDataAttrs } from '../../internal/dataState'
import { Slot } from '../../internal/slot'
import { useTradeCardContext } from './context'
import type { TradeCardInputProps } from './TradeCard.types'

/**
 * `TradeCardInput` — displays what is being traded on the active side (R4, R6, R9).
 *
 * This Part DISPLAYS the collection/quantity being traded; it renders no form
 * control of its own (no real `<input>`/quantity picker) — the partner owns the
 * actual quantity picker/tokenId selector, exactly the split `56-SPEC.md`'s Input
 * requirement draws. Collection identity always comes from `collectionInfo.data.
 * labels.name`/`.labels.symbol` (the subgraph/on-chain-resolved labels every product
 * in this workspace renders — CLAUDE.md's collection-identity rule) — NEVER the raw
 * `0x…` collection address, even as a fallback.
 *
 * Quantity comes from the plan-05 `params` context field (`TradeCard.types.ts`'s
 * `TradeCardParams`): `tokenIds.length` when a concrete sell/nft-to-nft selection
 * exists, otherwise the plain `count` a buy side carries — neither is an `Amount`, so
 * both render as plain numbers/lengths, never through a formatting call.
 */
export function TradeCardInput(props: TradeCardInputProps): ReactNode {
  const ctx = useTradeCardContext()
  const { collectionInfo, side, params } = ctx

  const quantity = params.tokenIds !== undefined ? params.tokenIds.length : params.count

  const defaultContent: ReactNode = (
    <>
      <span data-testid="input-collection-name">{collectionInfo.data?.labels.name}</span>
      <span data-testid="input-collection-symbol">{collectionInfo.data?.labels.symbol}</span>
      {quantity !== undefined ? <span data-testid="input-quantity">{quantity}</span> : null}
    </>
  )

  // Render-prop override (a function fully replaces `defaultContent`); a plain
  // element passed as `children` when NOT `asChild` also replaces `defaultContent`
  // (a partner's own literal markup). When `asChild` IS set, `children` is the single
  // substitution target `Slot` clones, never treated as override content here — the
  // computed content is injected onto that same element below instead.
  const overrideContent =
    typeof props.children === 'function' ? props.children(ctx) : props.asChild ? undefined : props.children
  const content = overrideContent ?? defaultContent

  const mergedClassName = mergeClassNames(props.className)
  const dataAttrs = toDataAttrs({ part: 'input', side, loading: collectionInfo.isLoading })

  if (props.asChild) {
    const slotProps = { ...dataAttrs, ...(mergedClassName === undefined ? {} : { className: mergedClassName }) }
    // `cloneElement` injects this Part's own computed `content` as the substituted
    // element's children BEFORE handing it to `Slot` — `Slot`'s own job (`slot.tsx`)
    // is merging attrs/className/ref onto a single element, never supplying its
    // content. See `PoolStatsPrice.tsx`'s header comment for the precedent; this is
    // not a re-implementation of any of `Slot`'s own merge logic.
    const substituted = cloneElement(props.children as ReactElement, undefined, content)
    return <Slot {...slotProps}>{substituted}</Slot>
  }

  return (
    <div className={mergedClassName} {...dataAttrs}>
      {content}
    </div>
  )
}
