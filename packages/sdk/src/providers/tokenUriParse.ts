/**
 * `tokenURI` string parser — pure, no fetch, no `Buffer` dependency.
 *
 * `tokenURI(id)` on an ERC-721 typically returns a URI POINTING AT a metadata JSON
 * document, not the image itself. Three schemes appear in the wild:
 * 1. `data:application/json;base64,...` — the whole document is already in hand.
 * 2. `data:application/json,...` (URL-encoded or raw) — same, no network needed.
 * 3. `ipfs://...` / `ar://...` / `https://...` — a document the SDK would have to
 * FETCH to read.
 *
 * This module never performs step 3's fetch. A `tokenURI` string is attacker-
 * influenceable — anyone who can mint into a collection chooses it — and resolving an
 * `https://`/`ipfs://` pointer would mean this package issuing an outbound HTTP
 * request, from a partner's own page, to a host the SDK never chose and cannot vet.
 * That is exactly the SSRF-shaped hazard this module mitigates by never fetching. For those three schemes,
 * `parseTokenUri` returns the URI itself as the candidate `image` — some on-chain
 * contracts (particularly on-chain-SVG collections) DO return an image URI directly
 * from `tokenURI` with no metadata-JSON indirection, and for the ones that don't, the
 * raw URI is still the only honest thing this function can hand back without
 * fetching. A partner who wants full metadata-JSON traversal (and can accept the
 * fetch) supplies their own `images` provider — this module's whole reason to
 * exist is the keyless, zero-network default, not a complete metadata resolver.
 *
 * No specific IPFS gateway host is chosen or hardcoded anywhere in this package — an
 * `ipfs://` URI is returned scheme-and-all, so the partner picks whichever public
 * gateway they trust (`pnpm grep:gate`'s sibling check, `test/providers/
 * defaults.test.ts`, asserts no gateway host appears in this package's source).
 */

/** What `parseTokenUri` could recover from a `tokenURI` string. `image`/`name` are
 * only populated for the `data:` schemes, where the document was actually decoded;
 * for `ipfs:`/`ar:`/`https:`, `image` is the URI itself (see this file's header) and
 * `name` stays `undefined`. `raw` is always the original, untouched input. */
export interface ParsedTokenUri {
  readonly image?: string
  readonly name?: string
  readonly raw: string
}

/** The subset of ERC-721/1155 metadata JSON fields this parser reads. Everything else
 * in the document is ignored. */
interface NftMetadataDocument {
  readonly name?: unknown
  readonly image?: unknown
  readonly image_url?: unknown
  readonly image_data?: unknown
}

const DATA_JSON_BASE64 = /^data:application\/json;base64,/i
/** The plain, `utf8` and `charset` variants all appear in the wild. */
const DATA_JSON_PLAIN = /^data:application\/json(;utf8|;charset=utf-?8)?,/i
const IPFS_SCHEME = /^ipfs:\/\//i
const AR_SCHEME = /^ar:\/\//i
const HTTPS_SCHEME = /^https:\/\//i

/**
 * Base64 decoded as UTF-8, not as latin-1. `atob` returns one character per BYTE, so a
 * document with an accented name or an emoji comes back mojibake and `JSON.parse` then
 * fails on a document that was perfectly valid — round-tripping the bytes through
 * `TextDecoder` is what makes the decode honest. `globalThis.atob` is available in
 * every browser and in Node >= 17.5 (this package targets Node >= 20, per its own
 * `engines` field) — no `Buffer` import, so this file works unmodified in a browser
 * bundle.
 */
function decodeBase64Utf8(payload: string): string | undefined {
  try {
    const binary = atob(payload)
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    return new TextDecoder('utf-8').decode(bytes)
  } catch {
    return undefined
  }
}

function parseJsonDocument(raw: string): NftMetadataDocument | undefined {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return parsed
  } catch {
    return undefined
  }
}

function firstNonEmptyString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return undefined
}

/** `image` first, then `image_url` (older collections/marketplaces), then
 * `image_data` — raw inline markup, wrapped as an image data URL so it can only ever
 * reach an `<img>` element, never execute (mirrors a sibling SnF product's own
 * `pickMetadataImage` precedence). */
function pickImage(doc: NftMetadataDocument): string | undefined {
  const candidate = firstNonEmptyString(doc.image, doc.image_url)
  if (candidate !== undefined) return candidate
  if (typeof doc.image_data === 'string' && doc.image_data.trim().length > 0) {
    return `data:image/svg+xml;base64,${btoa(doc.image_data)}`
  }
  return undefined
}

function fromDocument(doc: NftMetadataDocument | undefined, raw: string): ParsedTokenUri | undefined {
  if (!doc) return undefined
  const name = firstNonEmptyString(doc.name)
  const image = pickImage(doc)
  // Built by conditional spread, never by assigning `undefined` to an optional key —
  // `exactOptionalPropertyTypes: true` treats "key present with value `undefined`"
  // as distinct from "key absent", and `ParsedTokenUri`'s fields mean the latter.
  return {
    raw,
    ...(image !== undefined ? { image } : {}),
    ...(name !== undefined ? { name } : {}),
  }
}

/**
 * Parses a `tokenURI` string. Returns `undefined` for anything malformed or
 * unrecognised (an empty string, unparseable JSON, an unknown scheme) — a single bad
 * document must never throw and must never take down a batch (see
 * `onChainImages.ts`).
 */
export function parseTokenUri(uri: string | undefined): ParsedTokenUri | undefined {
  if (typeof uri !== 'string') return undefined
  const trimmed = uri.trim()
  if (trimmed.length === 0) return undefined

  if (DATA_JSON_BASE64.test(trimmed)) {
    const decoded = decodeBase64Utf8(trimmed.replace(DATA_JSON_BASE64, ''))
    return decoded === undefined ? undefined : fromDocument(parseJsonDocument(decoded), trimmed)
  }

  if (DATA_JSON_PLAIN.test(trimmed)) {
    let decoded: string
    try {
      decoded = decodeURIComponent(trimmed.replace(DATA_JSON_PLAIN, ''))
    } catch {
      return undefined
    }
    return fromDocument(parseJsonDocument(decoded), trimmed)
  }

  // Never fetched — see this file's header. The URI is handed back as-is, scheme and
  // all, as the best-effort candidate `image`.
  if (IPFS_SCHEME.test(trimmed) || AR_SCHEME.test(trimmed) || HTTPS_SCHEME.test(trimmed)) {
    return { image: trimmed, raw: trimmed }
  }

  return undefined
}
