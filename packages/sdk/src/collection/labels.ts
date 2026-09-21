import { notImplemented } from '../internal/stub'
import type { CollectionLabels } from '../types/collection.types'

/**
 * Pure display-name resolution — NEVER returns an address (full or shortened) unless
 * every other source is exhausted, and NEVER returns the wrapper's generic symbol
 * (`WNFT`) as the collection's identity (`.specs/codebase/COLLECTION_IDENTITY.md`).
 *
 * @gsd-stub — implemented by plan 10. Source analog:
 * snf-client/src/lib/collections/displayName.ts + addressName.ts.
 */
export function getCollectionLabels(input: {
  readonly symbol?: string
  readonly name?: string
  readonly address: `0x${string}`
}): CollectionLabels {
  void input
  return notImplemented('getCollectionLabels', '10')
}
