#!/usr/bin/env node
// scripts/forbidden-name-fingerprints.mjs
//
// The single source of truth for the forbidden-name fingerprint guard — shared by
// `scripts/release-gate.mjs` (checks 2 and 6) and
// `packages/sdk/test/abis/inventory.test.ts`, so there is exactly one place the
// fingerprint set and the matching logic live, never a second independent plaintext
// copy drifting out of sync with this one.
//
// A gate that keeps a plaintext deny-list is only as private as the file it lives
// in — publish the file, and the list itself becomes the disclosure it exists to
// prevent. This guard instead stores only the SHA-256 fingerprint of each
// forbidden identifier (lowercased before hashing — comparisons below are
// case-insensitive, matching the original substring check's behavior). It never
// holds, logs, or derives the plaintext identifiers themselves; a failure report
// can therefore only ever say THAT an identifier's fingerprint matched, and
// WHERE — never WHICH identifier.
//
// The original mechanism matched by raw substring against a whole file's
// lowercased text, so a forbidden identifier embedded inside a longer compound
// identifier (prefix+name+suffix, e.g. a function name that contains one of the
// guarded words as an inner segment) was still caught. Fingerprinting whole
// candidate strings alone would lose that: a hash of a compound identifier
// doesn't reveal anything about a hash of a substring of it. To preserve
// coverage, every candidate identifier found in scanned text is decomposed into
// its "words" (splitting on `_`/`-` and on camelCase/acronym/digit boundaries),
// and every contiguous run of those words — from a single word up to the whole
// identifier — is fingerprinted and checked. A guarded word that lines up with
// natural identifier-word boundaries anywhere inside a longer identifier is
// still caught this way, exactly as the substring check would have caught
// it; only identifiers whose casing deliberately obscures every natural word
// boundary could slip past both this and the original mechanism.
import { createHash } from 'node:crypto'

export const FORBIDDEN_NAME_FINGERPRINTS = new Set([
  '17f29b073143d8cd97b5bbe492bdeffec1c5fee55cc1fe2112c8b9335f8b6121',
  '1e22a737a0a63204be0c83f899126d24d48ad317787ea5a431175de4347ba709',
  '41a01f9945b8b394953d4d44a1522eb9c7654c7fc86a572b71fc63408e854440',
  '45335bcffd7f70fa32d8d3c216b2cf384c752b4a6e2d2246fc36cea5ee1e6c60',
  '48b9f30d90d630c93fec79d11a4736e24d30d10c6e4ad033ce321c89229c8f2a',
  '7d458f2e1cb829f1d25c1a4f4cb5353b3bc5fbca2d8d62349b7e70cc22fe6738',
  '9aee9ba4da6002e08a0ea992b3b654d7f46a23d67124ec37c13eef1172d84617',
  'c279e4c4471257af26e9c2c739705a0171959e33aaae5061c6f3766ca1f7f96d',
  'c76f02cb19defd5ce516d730e5f6f2b3674ee1d8b86642ad82d2f938affb22b0',
  'c8cf701f30ad11d3ee877dced0d774ab2da9159894296887b8439a63c9aa0655',
  'df78f3743df088a526a599039eb8b18d6fe5f2a7ee38a3d56acfa82aa298d189',
  'e6f0a1fbb43c89196dcfcbef85908f19ab4c5f7cc4f4c452284697757683d7ef',
])

export function fingerprintOf(candidate) {
  return createHash('sha256').update(candidate.toLowerCase(), 'utf8').digest('hex')
}

/** Splits one `_`/`-`-delimited part into camelCase/acronym/digit "words":
 * lower-or-digit followed by upper (`xY` -> `x|Y`), an uppercase run followed
 * by an uppercase+lowercase pair (`XYz` -> `X|Yz`, the acronym case), and any
 * letter/digit transition (`x9` -> `x|9`, `9x` -> `9|x`). */
function splitCamelCase(part) {
  return part
    .replace(/([a-z0-9])([A-Z])/g, '$1\u0000$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1\u0000$2')
    .replace(/([A-Za-z])([0-9])/g, '$1\u0000$2')
    .replace(/([0-9])([A-Za-z])/g, '$1\u0000$2')
    .split('\u0000')
    .filter(Boolean)
}

function segmentToken(token) {
  const words = []
  for (const part of token.split(/[_-]+/).filter(Boolean)) words.push(...splitCamelCase(part))
  return words
}

/** Every contiguous run of a token's words, concatenated and lowercased, plus
 * the raw token itself — the full candidate set checked against
 * FORBIDDEN_NAME_FINGERPRINTS for one token. */
export function candidatesForToken(token) {
  const words = segmentToken(token)
  const candidates = new Set([token.toLowerCase()])
  for (let i = 0; i < words.length; i++) {
    let run = ''
    for (let j = i; j < words.length; j++) {
      run += words[j]
      candidates.add(run.toLowerCase())
    }
  }
  return candidates
}

function tokensFromText(text) {
  const raw = text.match(/[A-Za-z0-9_-]+/g) || []
  return raw.filter((t) => /[A-Za-z]/.test(t))
}

/** 1-based line numbers where some candidate identifier on that line
 * fingerprints to an entry in FORBIDDEN_NAME_FINGERPRINTS. Deliberately
 * returns only line numbers — never the token, the candidate, or the line's
 * text — so a caller can report WHERE a match happened without ever being
 * able to say WHAT matched. */
export function findForbiddenFingerprintLines(text) {
  const hitLines = []
  text.split('\n').forEach((line, i) => {
    for (const token of tokensFromText(line)) {
      for (const candidate of candidatesForToken(token)) {
        if (FORBIDDEN_NAME_FINGERPRINTS.has(fingerprintOf(candidate))) {
          hitLines.push(i + 1)
          return
        }
      }
    }
  })
  return hitLines
}

/** Convenience boolean wrapper over `findForbiddenFingerprintLines` for callers
 * (like a test's `it.each`) that only need a yes/no answer, not line numbers. */
export function containsForbiddenName(text) {
  return findForbiddenFingerprintLines(text).length > 0
}
