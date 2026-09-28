import { getChain } from './chains/registry'
import { assertParam } from './errors'
import type {
  AppLinkOptions,
  AppLinkToken,
  AppLiquidityLinkArgs,
  AppSwapLinkArgs,
} from './types/appLinks.types'

/**
 * `appLinks` — canonical URLs into the public SnF app: one pool, one liquidity tab, or
 * the swap page, always naming the chain (`chain={chainId}`) so a visitor whose wallet
 * or config is on a different chain still lands on the right one instead of the app
 * falling back to whatever chain happens to be active. Every function here only
 * concatenates a string — nothing in this module ever performs a fetch, a read, or any
 * other I/O, and none of the addresses/options accepted are ever hardcoded into a
 * request: they only ever end up in a URL a partner renders for a user to click.
 *
 * `DEFAULT_ORIGIN` below is the ONLY occurrence of the app's origin literal anywhere
 * under `packages/*\/src` — every other reference to the app goes through
 * `resolveOrigin`, so this file is the single place that would ever need to change if
 * that origin ever did.
 */
const DEFAULT_ORIGIN = 'https://app.sweepnflip.io'

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

/** Validates and lowercases an address-shaped link parameter. Lowercased on purpose:
 * the app's own pool ids are the subgraph's lowercase ids, and its add-liquidity
 * preselect compares the `pool` query param against them with `===` — a checksummed
 * (mixed-case) id would silently fail to preselect. */
function linkAddress(value: string, field: string): string {
  assertParam(ADDRESS_RE.test(value), `${field} must be a 0x-prefixed 40-hex-character address`, {
    field,
    value,
  })
  return value.toLowerCase()
}

/** `'native'` maps to the app's own `eth` sentinel, which the app resolves to each
 * chain's own native asset (USDC on Arc, the chain's native gas token elsewhere).
 * `undefined` stays `undefined` — an omitted swap side is omitted from the URL. */
function linkToken(value: AppLinkToken | undefined, field: string): string | undefined {
  if (value === undefined) return undefined
  if (value === 'native') return 'eth'
  return linkAddress(value, field)
}

/** Parses `raw` with the platform `URL` constructor, returning `undefined` (never
 * throwing) on a malformed string — the caller turns that into a proper
 * `INVALID_PARAMS` via `assertParam`. */
function tryParseUrl(raw: string): URL | undefined {
  try {
    return new URL(raw)
  } catch {
    return undefined
  }
}

/** Resolves the origin every link is built against. Omitted, this is the public app.
 * Supplied, it must be a BARE `https:` origin — no path, query, hash, username or
 * password — anything else throws `INVALID_PARAMS` naming `details.field === 'origin'`,
 * so a partner can never point a generated link at a non-TLS host or smuggle extra URL
 * structure past this builder. */
function resolveOrigin(opts?: AppLinkOptions): string {
  if (opts?.origin === undefined) return DEFAULT_ORIGIN

  const raw = opts.origin
  const parsed = tryParseUrl(raw)
  assertParam(parsed !== undefined, 'opts.origin must be a valid URL', {
    field: 'origin',
    value: raw,
  })

  const isBareHttpsOrigin =
    parsed.protocol === 'https:' &&
    parsed.pathname === '/' &&
    parsed.search === '' &&
    parsed.hash === '' &&
    parsed.username === '' &&
    parsed.password === ''
  assertParam(
    isBareHttpsOrigin,
    'opts.origin must be a bare https:// origin — no path, query, hash or credentials',
    { field: 'origin', value: raw },
  )

  return parsed.origin
}

/** A specific pool's page. */
function pool(chainId: number, pair: `0x${string}`, opts?: AppLinkOptions): string {
  getChain(chainId)
  const origin = resolveOrigin(opts)
  const lowerPair = linkAddress(pair, 'pair')

  const params = new URLSearchParams()
  params.set('chain', String(chainId))

  return `${origin}/pools/${lowerPair}?${params.toString()}`
}

/** The liquidity page, deep-linked to add/remove an existing pool's position or to
 * create a new pool prefilled with a collection. */
function liquidity(chainId: number, args: AppLiquidityLinkArgs, opts?: AppLinkOptions): string {
  getChain(chainId)
  const origin = resolveOrigin(opts)

  const params = new URLSearchParams()
  params.set('tab', args.tab)
  if (args.tab === 'create') {
    params.set('collection', linkAddress(args.collection, 'collection'))
  } else {
    params.set('pool', linkAddress(args.pair, 'pair'))
  }
  params.set('chain', String(chainId))

  return `${origin}/liquidity?${params.toString()}`
}

/** The swap page, with optional preselected sides. An omitted side is omitted from the
 * URL entirely — never emitted as an empty parameter. */
function swap(chainId: number, args?: AppSwapLinkArgs, opts?: AppLinkOptions): string {
  getChain(chainId)
  const origin = resolveOrigin(opts)

  const params = new URLSearchParams()
  params.set('chain', String(chainId))
  const tokenIn = linkToken(args?.tokenIn, 'tokenIn')
  if (tokenIn !== undefined) params.set('tokenIn', tokenIn)
  const tokenOut = linkToken(args?.tokenOut, 'tokenOut')
  if (tokenOut !== undefined) params.set('tokenOut', tokenOut)

  return `${origin}/swap?${params.toString()}`
}

export const appLinks = { pool, liquidity, swap } as const
