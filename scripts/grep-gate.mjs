#!/usr/bin/env node
// scripts/grep-gate.mjs
//
// this rule's CI acceptance criterion made executable: scans packages/*/src AND
// packages/*/dist for SnF backend calls, third-party hosts, process.env reads and
// private-client imports. Scans `dist` as well as `src` so a transitive re-export
// cannot smuggle a forbidden string past a source-only scan.
//
// Comment-stripping: the THIRD-PARTY-HOST/env rules below are checked with `//` and
// `/* ... */` comments removed first, so a doc comment that *names* a forbidden
// pattern (this repo's own rule docs do exactly that) cannot self-invalidate the
// gate.
//
// `goldsky` is deliberately NOT a banned pattern: a Goldsky subgraph URL is legal
// in `src/chains/registry.ts` (Requires the 14 literal URLs) and therefore in
// `dist` too. The other three third-party hosts stay banned everywhere (not just
// `dist`) — a partner-facing package has no legitimate reason to hardcode any of
// them in source either.
//
// The APPARATUS_RULES block below is the PERMANENT half of this repository's
// pre-publication cleanup: generic patterns for the internal planning apparatus
// (decision/requirement/threat IDs, phase-document filenames, `.planning/`, `gsd-`
// tooling references, "wave N"/"plan NN" citations) and for paths into this
// workspace's other, private repositories. None of these patterns is itself a
// secret — publishing the pattern only says "we don't want this kind of citation
// back in the tree", the same way a linter's own rule source is safe to publish.
// Unlike the third-party-host rules above, these run against the RAW,
// comment-INCLUSIVE text — packages/*/src has no legitimate reason to carry any of
// these citations even inside a comment, so a reintroduced "D-07: ..." doc-comment
// note fails this gate exactly as a reintroduced code reference would.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()

const RULES = [
  { id: 'sweepnflip.io', re: /sweepnflip\.io/ },
  { id: 'NEXT_PUBLIC_', re: /NEXT_PUBLIC_/ },
  { id: 'process.env', re: /process\.env/ },
  { id: 'private-client import', re: /from\s+['"]snf-client|require\(\s*['"]snf-client/ },
  { id: 'alchemy.com', re: /alchemy\.com/ },
  { id: 'opensea.io', re: /opensea\.io/ },
  { id: 'coingecko.com', re: /coingecko\.com/ },
]

// --- internal planning apparatus + paths into this workspace's other, private
// repositories — checked against RAW text (comments included). ------------------
const APPARATUS_RULES = [
  { id: 'decision ID (D-NN)', re: /\bD-\d{2}\b/ },
  { id: 'requirement ID (REQ-SDK-NN)', re: /\bREQ-SDK-\d+\b/ },
  { id: 'requirement ID (REQ-INT-NN)', re: /\bREQ-INT-\d+\b/ },
  { id: 'threat ID (T-5N-NN)', re: /\bT-5\d-\d+\b/ },
  { id: 'open-decision ID (OD-SDK-N)', re: /\bOD-SDK-\d+\b/ },
  { id: 'phase document filename', re: /\b\d{2,3}-(SPEC|CONTEXT|RESEARCH|PATTERNS)\.md\b/ },
  { id: 'phase artifact filename (snf-NN-NN-PLAN/SUMMARY.md)', re: /\bsnf-\d+-\d+-(PLAN|SUMMARY)\.md\b/ },
  { id: 'phase artifact filename (snf-NN-NNF)', re: /\bsnf-\d+-\d+F\b/ },
  { id: '.planning/ path', re: /\.planning\// },
  { id: 'gsd- tooling reference', re: /\bgsd-/ },
  { id: '"wave N" citation', re: /\bwave \d{1,3}\b/ },
  { id: '"plan NN" citation', re: /\bplan \d{1,3}\b/ },
  { id: 'snf-client/ path', re: /snf-client\// },
  { id: 'snf-contracts path', re: /snf-contracts\b/ },
  { id: 'snf-drops-registration path', re: /snf-drops-registration\b/ },
  { id: 'snf-tests path', re: /snf-tests\b/ },
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
  const raw = readFileSync(file, 'utf8')
  const cleaned = stripComments(raw)
  const hits = []
  cleaned.split('\n').forEach((line, i) => {
    for (const rule of RULES) {
      if (rule.re.test(line)) {
        hits.push({ file, line: i + 1, rule: rule.id, match: line.trim().slice(0, 120) })
      }
    }
  })
  // APPARATUS_RULES run against the RAW text — a reintroduced apparatus citation
  // or private-repo path fails this gate whether it lands in a comment or in code.
  raw.split('\n').forEach((line, i) => {
    for (const rule of APPARATUS_RULES) {
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
    'grep-gate: clean (no sweepnflip.io, NEXT_PUBLIC_, process.env, private-client import, banned third-party host, internal-planning-apparatus citation, or private-repo path found in packages/*/src or packages/*/dist)',
  )
  process.exit(0)
}
