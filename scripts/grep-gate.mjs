#!/usr/bin/env node
// scripts/grep-gate.mjs
//
// R19's CI acceptance criterion made executable: scans packages/*/src AND
// packages/*/dist for SnF backend calls, third-party hosts, process.env reads and
// snf-client imports. Scans `dist` as well as `src` so a transitive re-export
// cannot smuggle a forbidden string past a source-only scan.
//
// Comment-stripping: each file is checked with `//` and `/* ... */` comments
// removed first, so a doc comment that *names* a forbidden pattern (this repo's
// own rule docs do exactly that) cannot self-invalidate the gate.
//
// `goldsky` is deliberately NOT a banned pattern: a Goldsky subgraph URL is legal
// in `src/chains/registry.ts` (R2 requires the 14 literal URLs) and therefore in
// `dist` too. The other three third-party hosts stay banned everywhere (not just
// `dist`) — a partner-facing package has no legitimate reason to hardcode any of
// them in source either.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()

const RULES = [
  { id: 'sweepnflip.io', re: /sweepnflip\.io/ },
  { id: 'NEXT_PUBLIC_', re: /NEXT_PUBLIC_/ },
  { id: 'process.env', re: /process\.env/ },
  { id: 'snf-client import', re: /from\s+['"]snf-client|require\(\s*['"]snf-client/ },
  { id: 'alchemy.com', re: /alchemy\.com/ },
  { id: 'opensea.io', re: /opensea\.io/ },
  { id: 'coingecko.com', re: /coingecko\.com/ },
]

function stripComments(source) {
  // Negative lookbehind on `:` keeps `http://`/`https://` intact — a naive `//.*$`
  // strip would delete an entire literal SnF/third-party URL (everything after the
  // scheme's `//` looks like "the rest of the comment"), silently defeating the very
  // patterns this gate exists to catch. Block comments have no such false positive.
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/.*$/gm, '')
}

function walk(dir, out) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry === 'node_modules') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      walk(full, out)
    } else if (!entry.endsWith('.map')) {
      out.push(full)
    }
  }
}

function scanFile(file) {
  const cleaned = stripComments(readFileSync(file, 'utf8'))
  const hits = []
  cleaned.split('\n').forEach((line, i) => {
    for (const rule of RULES) {
      if (rule.re.test(line)) {
        hits.push({ file, line: i + 1, rule: rule.id, match: line.trim().slice(0, 120) })
      }
    }
  })
  return hits
}

function findPackageDirs() {
  const packagesDir = join(ROOT, 'packages')
  let names
  try {
    names = readdirSync(packagesDir)
  } catch {
    return []
  }
  return names.map((name) => join(packagesDir, name)).filter((p) => statSync(p).isDirectory())
}

const allHits = []
for (const pkgDir of findPackageDirs()) {
  for (const sub of ['src', 'dist']) {
    const files = []
    walk(join(pkgDir, sub), files)
    for (const file of files) allHits.push(...scanFile(file))
  }
}

if (allHits.length > 0) {
  console.error(`grep-gate: found ${allHits.length} prohibited pattern hit(s):\n`)
  for (const hit of allHits) {
    console.error(`  ${relative(ROOT, hit.file)}:${hit.line}  [${hit.rule}]  ${hit.match}`)
  }
  process.exit(1)
} else {
  console.log(
    'grep-gate: clean (no sweepnflip.io, NEXT_PUBLIC_, process.env, snf-client import, or banned third-party host found in packages/*/src or packages/*/dist)',
  )
  process.exit(0)
}
