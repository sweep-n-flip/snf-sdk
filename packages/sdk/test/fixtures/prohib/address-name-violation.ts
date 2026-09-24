/**
 * `address-name-violation.ts` — the DELIBERATE anti-pattern the address-as-name
 * rule forbids, kept ONLY as a test subject for
 * `test/prohibitions/no-address-as-name.test.ts` (`SNF_SDK_PROHIB_SUBJECT`). MUST NEVER
 * be imported by `src/` (see `caller-price-violation.ts`'s identical header note).
 *
 * Reproduces the historical "reject full address only" guard `src/collection/
 * labels.ts`'s own `isAddressLike` doc comment warns about: this version only
 * recognises a FULL 42-char `0x` + 40-hex address as invalid, never the SHORTENED
 * `0x7c47…70eb` / `0x7c47...70eb` form a subgraph or an upstream caller might hand it
 * as a "name". A shortened address therefore sails through as if it were a real
 * name, WITHOUT setting `nameIsFallback: true` — the exact bug that historically
 * slipped through.
 */
const FULL_ADDRESS_ONLY = /^0x[0-9a-fA-F]{40}$/

export interface CollectionLabelsInputLike {
  readonly address: string
  readonly subgraphName?: string | null | undefined
  readonly subgraphSymbol?: string | null | undefined
  readonly onChainName?: string | null | undefined
  readonly onChainSymbol?: string | null | undefined
}

export interface CollectionLabelsLike {
  readonly name: string
  readonly symbol: string
  readonly nameIsFallback: boolean
}

function usable(value: string | null | undefined): value is string {
  if (!value) return false
  const v = value.trim()
  if (!v) return false
  // THE VIOLATION: only the full 42-char form is rejected — a shortened address
  // (`0x7c47…70eb`) is treated as a perfectly usable name.
  return !FULL_ADDRESS_ONLY.test(v)
}

export function getCollectionLabels(input: CollectionLabelsInputLike): CollectionLabelsLike {
  const candidates = [input.subgraphName, input.onChainName, input.subgraphSymbol, input.onChainSymbol]
  for (const candidate of candidates) {
    if (usable(candidate)) {
      return { name: candidate as string, symbol: candidate as string, nameIsFallback: false }
    }
  }
  const short = `${input.address.slice(0, 6)}...${input.address.slice(-4)}`
  return { name: short, symbol: short, nameIsFallback: true }
}
