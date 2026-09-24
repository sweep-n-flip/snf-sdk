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
// tooling references, "wave N"/"plan NN" citations, internal spec-document
// citations, internal role/person mentions, private-repo paths, and this
// workspace's own auto-memory-file naming convention) and for paths into this
// workspace's other, private repositories. None of these patterns is itself a
// secret — publishing the pattern only says "we don't want this kind of citation
// back in the tree", the same way a linter's own rule source is safe to publish.
//
// Two scan tiers exist for two different reasons:
// 1. RULES (below) — third-party hosts, `process.env`, `NEXT_PUBLIC_`, a private-repo
//    import — stay scoped to `packages/*/src` and `packages/*/dist` exactly as
//    before, checked on COMMENT-STRIPPED text. These are behavioral/security rules
//    about what the PUBLISHED PACKAGE may contain, not about repo-wide provenance —
//    widening their scope would also flag legitimate, expected occurrences outside
//    the package (e.g. `NEXT_PUBLIC_` env vars documented in `examples/*/README.md`
//    and `.env.example`, which exist on purpose for the example apps).
// 2. APPARATUS_RULES (below) — internal-provenance and private-repo-path patterns —
//    now run over the WHOLE TRACKED TREE (`git ls-files`), not only `packages/*/src`
//    and `packages/*/dist`. A prior version of this gate scoped these to `src`/`dist`
//    only, so a citation in `test/`, `examples/`, or a root doc was invisible to it.
//    Checked against RAW, comment-INCLUSIVE text — none of this tree has a
//    legitimate reason to carry any of these citations even inside a comment, so a
//    reintroduced "D-07: ..." doc-comment note fails this gate exactly as a
//    reintroduced code reference would.
import { execSync } from 'node:child_process'
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
// repositories + this workspace's own internal citation conventions — checked
// against RAW text (comments included), over the whole tracked tree. -------------
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
  // --- added for the whole-tracked-tree extension (case-insensitive, matching the
  // residue-sweep command this gate makes permanent) -----------------------------
  { id: 'invariant ID (INV-NN)', re: /\bINV-\d+\b/i },
  { id: 'internal phase citation (Phase NN)', re: /\bPhase[- ]?\d{2,3}\b/i },
  { id: 'workspace journal citation (Entry #N)', re: /\bEntry #\d+\b/i },
  { id: 'internal role mention (founder)', re: /\bfounder\b/i },
  { id: 'internal-process mention (UAT)', re: /\bUAT\b/i },
  { id: 'internal role mention (CTO)', re: /\bCTO\b/i },
  { id: 'workspace auto-memory system mention', re: /auto-?memory/i },
  { id: 'workspace MEMORY.md mention', re: /\bMEMORY\.md\b/i },
  { id: 'snf-workspace path', re: /\bsnf-workspace\b/i },
  { id: 'internal tool mention (Notion)', re: /\bNotion\b/i },
  { id: 'internal role mention (vibecoder)', re: /\bvibecoder\b/i },
  { id: 'internal spec-document citation (DATASHEET)', re: /DATASHEET/i },
  {
    id: 'numbered SPEC prohibition citation',
    re: /prohibition #\d+|SPEC prohibition|prohibitions #\d+|amended \d{4}-\d{2}-\d{2} list|\(amended \d{4}/,
  },
  { id: 'snf-server path', re: /\bsnf-server\b/i },
  { id: 'snf-demo path', re: /\bsnf-demo\b/i },
  { id: 'snf-landpage path', re: /\bsnf-landpage\b/i },
  { id: 'snf-client mention (any form)', re: /snf-client/i },
  { id: 'auto-memory file citation (feedback_*)', re: /feedback_[a-z_]+/i },
  { id: 'auto-memory file citation (reference_*)', re: /reference_[a-z_]+/i },
  { id: 'auto-memory file citation (project_*)', re: /project_[a-z_]+/i },
  { id: 'internal UAT test-case citation (Case A-F)', re: /\bCase [A-F]\b/i },
]

// Exact, narrow (file, rule) exceptions to APPARATUS_RULES — never a general
// softening of a rule's regex, only a specific, documented, unavoidable false
// positive. Mirrors scripts/release-gate.mjs's own SECRETS_SCAN_EXCLUDE_PATHS
// discipline: exact path, not a weakened pattern, and every entry says why.
const APPARATUS_RULE_EXCEPTIONS = [
  {
    file: 'packages/sdk/src/chains/registry.ts',
    ruleId: 'auto-memory file citation (project_*)',
    reason:
      "Every literal Goldsky subgraph URL is shaped 'project_<opaque-id>' by Goldsky's " +
      "own hosting convention (their project identifier), not this repo's internal " +
      'auto-memory filename convention. These 14 URLs are required, functional data — ' +
      'the SDK cannot query the correct subgraph without them, on any chain.',
  },
  {
    file: 'examples/next-app/README.md',
    ruleId: 'auto-memory file citation (project_*)',
    reason:
      "WalletConnect Cloud's own standard env var name is " +
      "NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID — 'PROJECT_ID' here is WalletConnect's " +
      "term for their own project identifier, not this repo's internal auto-memory " +
      'filename convention. Renaming it in this doc alone would desync it from ' +
      'examples/next-app/.env.example, which declares the same name.',
  },
  {
    file: 'CHANGELOG.md',
    ruleId: 'gsd- tooling reference',
    reason:
      "The sole `gsd-` match here is `@gsd-stub`, this repo's own release-gate stub " +
      'marker (scripts/release-gate.mjs check 1) — the mechanism the task that added ' +
      'this rule explicitly said to leave in place, not a reintroduced planning-tool ' +
      'reference.',
  },
  {
    file: 'scripts/release-gate.mjs',
    ruleId: 'gsd- tooling reference',
    reason:
      "Every `gsd-` match here is `@gsd-stub`, this file's own release-gate stub " +
      'marker (check 1) — the mechanism itself, which must keep working and therefore ' +
      'must keep being spelled out literally in its own implementation.',
  },
]

function isApparatusRuleExcepted(relPath, ruleId) {
  return APPARATUS_RULE_EXCEPTIONS.some((ex) => ex.file === relPath && ex.ruleId === ruleId)
}

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

// RULES scan — packages/*/src and packages/*/dist only, on comment-stripped text.
// Unchanged in scope from before the whole-tracked-tree extension (see file header).
function scanFileForRules(file) {
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
    for (const file of files) allHits.push(...scanFileForRules(file))
  }
}

// APPARATUS_RULES scan — the whole tracked tree, on RAW text. Excludes only this
// file itself (its own rule table must spell every pattern it guards against) and
// any `.env`-shaped tracked file (this gate is not the place to police secrets —
// see scripts/release-gate.mjs's checkNoTrackedEnvFiles for that).
const BINARY_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2', '.map'])
const SELF_PATH = 'scripts/grep-gate.mjs'

function isEnvShaped(relPath) {
  const base = relPath.slice(relPath.lastIndexOf('/') + 1)
  return base.includes('.env')
}

function scanTrackedTreeForApparatus() {
  let tracked
  try {
    tracked = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)
  } catch (e) {
    return [{ file: join(ROOT, SELF_PATH), line: 0, rule: 'git ls-files failed', match: e.message }]
  }
  const hits = []
  for (const relPath of tracked) {
    if (relPath === SELF_PATH) continue
    if (isEnvShaped(relPath)) continue
    const ext = relPath.slice(relPath.lastIndexOf('.'))
    if (BINARY_EXTENSIONS.has(ext)) continue
    const full = join(ROOT, relPath)
    let raw
    try {
      raw = readFileSync(full, 'utf8')
    } catch {
      continue
    }
    raw.split('\n').forEach((line, i) => {
      for (const rule of APPARATUS_RULES) {
        if (isApparatusRuleExcepted(relPath, rule.id)) continue
        if (rule.re.test(line)) {
          hits.push({ file: full, line: i + 1, rule: rule.id, match: line.trim().slice(0, 120) })
        }
      }
    })
  }
  return hits
}

allHits.push(...scanTrackedTreeForApparatus())

if (allHits.length > 0) {
  console.error(`grep-gate: found ${allHits.length} prohibited pattern hit(s):\n`)
  for (const hit of allHits) {
    console.error(`  ${relative(ROOT, hit.file)}:${hit.line}  [${hit.rule}]  ${hit.match}`)
  }
  process.exit(1)
} else {
  console.log(
    'grep-gate: clean (no sweepnflip.io, NEXT_PUBLIC_, process.env, private-client import, banned third-party ' +
      'host in packages/*/src or packages/*/dist; no internal-planning-apparatus citation or private-repo path ' +
      'anywhere in the tracked tree)',
  )
  process.exit(0)
}
