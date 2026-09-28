import { concat, hexToBytes, isHex, numberToHex, stringToHex } from 'viem'
import type { Hex } from 'viem'

import { assertParam } from '../errors'

/**
 * ERC-8021 transaction attribution, schema 0 — the wire format:
 *
 * ```
 * [ codes: ASCII, comma-separated ][ codesLength: uint8 ][ schemaId: uint8 = 0x00 ][ ercSuffix: 16 bytes ]
 * ```
 *
 * appended to the END of a transaction's calldata. Contracts ignore trailing calldata
 * (the ABI decoder reads fixed offsets), so the suffix changes nothing on-chain; it is
 * read off-chain by indexers to attribute the transaction to the codes it carries.
 *
 * The encoder here is byte-identical to `ox/erc8021`'s `Attribution.toDataSuffix` for
 * schema 0 (proven against `ox`-generated vectors in this package's tests). It is
 * implemented locally, on viem's own hex utilities, so `viem` stays this package's
 * only peer dependency.
 */

/** The 16-byte ERC-8021 marker every attributed calldata ends with. */
export const ERC8021_MARKER = '0x80218021802180218021802180218021' as const

/** Marker (16) + schemaId (1) + codesLength (1): the fixed tail of a schema-0 suffix. */
const FIXED_TAIL_BYTES = 18
const MARKER_BYTES = 16
const SELECTOR_BYTES = 4
const MAX_CODES_BYTES = 255
const COMMA = 0x2c
const PRINTABLE_MIN = 0x21
const PRINTABLE_MAX = 0x7e

function isPrintableNoSpace(byte: number): boolean {
  return byte >= PRINTABLE_MIN && byte <= PRINTABLE_MAX
}

/** True when every UTF-16 unit of `code` is printable ASCII other than a comma — so
 * the string's byte length equals its `.length`. */
function isEncodableCode(code: string): boolean {
  if (code.length === 0) return false
  for (let i = 0; i < code.length; i += 1) {
    const unit = code.charCodeAt(i)
    if (unit === COMMA || !isPrintableNoSpace(unit)) return false
  }
  return true
}

/**
 * Encodes an ERC-8021 schema-0 data suffix for `codes`, ready to append to calldata
 * (`concat([data, suffix])`, or viem's `dataSuffix` option on any write/estimate).
 *
 * Each code must be non-empty printable ASCII with no space and no comma (a comma is
 * the list separator), and the comma-joined list must fit in 255 bytes. Anything else
 * throws `SnfError('INVALID_PARAMS')` — an encoder that silently produced a suffix
 * its own parser rejects would tag nothing. Case is preserved as given; readers
 * lowercase.
 */
export function encodeAttribution(codes: readonly string[]): Hex {
  assertParam(Array.isArray(codes) && codes.length > 0, 'attribution codes must be a non-empty array', {
    field: 'codes',
  })
  for (const code of codes) {
    assertParam(
      typeof code === 'string' && isEncodableCode(code),
      'each attribution code must be non-empty printable ASCII with no space or comma',
      { field: 'codes', value: code },
    )
  }
  const joined = codes.join(',')
  assertParam(joined.length <= MAX_CODES_BYTES, 'attribution codes must fit in 255 bytes when comma-joined', {
    field: 'codes',
    value: joined.length,
  })
  return concat([stringToHex(joined), numberToHex(joined.length, { size: 1 }), '0x00', ERC8021_MARKER])
}

/**
 * Reads the ERC-8021 schema-0 codes from the end of `data` (a transaction's full
 * input). Returns `null` for anything that is not a well-formed schema-0 suffix;
 * never throws. Strict on purpose — stricter than a generic ERC-8021 reader:
 *
 * 1. at least 18 bytes, and the last 16 are the ERC-8021 marker;
 * 2. the schema byte is `0x00` (schemas 1 and 2 read as `null`, not as an error);
 * 3. the codes length `n` is non-zero and the codes never overlap the 4-byte function
 *    selector (`L - 18 - n >= 4`);
 * 4. every codes byte is printable ASCII with no space (`0x21..0x7e`);
 * 5. the codes split on `,`, empty entries are dropped and `A-Z` is lowercased — an
 *    empty result is `null`.
 *
 * This exact algorithm is shared with every other reader of the format, so the same
 * transaction attributes identically everywhere.
 */
export function parseAttribution(data: Hex): string[] | null {
  if (typeof data !== 'string' || !isHex(data, { strict: true }) || data.length % 2 !== 0) return null
  const bytes = hexToBytes(data)
  const length = bytes.length
  if (length < FIXED_TAIL_BYTES) return null

  const marker = hexToBytes(ERC8021_MARKER)
  for (let i = 0; i < MARKER_BYTES; i += 1) {
    if (bytes[length - MARKER_BYTES + i] !== marker[i]) return null
  }
  if (bytes[length - MARKER_BYTES - 1] !== 0x00) return null

  const codesLength = bytes[length - FIXED_TAIL_BYTES] ?? 0
  const start = length - FIXED_TAIL_BYTES - codesLength
  if (codesLength === 0 || start < SELECTOR_BYTES) return null

  const codesBytes = bytes.subarray(start, length - FIXED_TAIL_BYTES)
  if (!codesBytes.every(isPrintableNoSpace)) return null

  const codes: string[] = []
  let current = ''
  for (const byte of codesBytes) {
    if (byte === COMMA) {
      if (current.length > 0) codes.push(current)
      current = ''
    } else {
      current += String.fromCharCode(byte).toLowerCase()
    }
  }
  if (current.length > 0) codes.push(current)
  return codes.length > 0 ? codes : null
}
