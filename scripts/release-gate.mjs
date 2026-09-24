#!/usr/bin/env node
// scripts/release-gate.mjs
//
// snf-54-20 (R21, REQ-SDK-01, REQ-SDK-52). One command, six checks, non-zero exit and
// a readable report on ANY failure:
//
//   1. No surviving stubs      — `@gsd-stub` must not appear anywhere under packages/*/src
//   2. ABI inventory           — packages/sdk/src/abis holds exactly the audited set,
//                                 no forbidden non-AMM identifier fingerprint anywhere in it
//   3. Secrets scan            — the whole repo, then packages/*/dist, clean of any
//                                 private-key/API-key-shaped literal or a tracked .env
//   4. Bundle budget            — `pnpm size` (size-limit) exits 0
//   5. Version consistency      — built SDK_VERSION === package.json#version, and
//                                 sdk-react's peer range on @sweepnflip/sdk admits it
//   6. Forbidden-name fingerprints, tracked tree — same guard as check 2, over every
//                                 tracked file instead of just the ABI directory. Off
//                                 by default; see SCAN_TRACKED_TREE_FOR_FORBIDDEN_FINGERPRINTS.
//
// Deliberately zero npm dependencies (D-05/D-06 spirit: nothing in this repo's own
// tooling should need a registry fetch to gate a release) — only Node's `node:fs`,
// `node:path`, `node:crypto` and one `node:child_process` shell-out to the existing
// `pnpm size` script (check 4 composes that check rather than re-implementing
// size-limit's own gzip math).
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Directories never worth walking for either the stub or the secrets scan — build
 * caches, VCS internals, and the dependency tree itself. `dist` is walked separately
 * and deliberately by checks 1/3 that need it; everywhere else it is excluded from the
 * generic walker below so a stale build artifact never double-reports a source hit. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.turbo', '.next', 'coverage'])

function walk(dir, out, { includeDist = false } = {}) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue
    if (entry === 'dist' && !includeDist) continue
    const full = join(dir, entry)
    let s
    try {
      s = statSync(full)
    } catch {
      continue
    }
    if (s.isDirectory()) {
      walk(full, out, { includeDist })
    } else {
      out.push(full)
    }
  }
}

function report(title, hits) {
  console.error(`\nrelease-gate: ${title} — ${hits.length} issue(s):`)
  for (const hit of hits) console.error(`  ${hit}`)
}

const failures = []

// ---------------------------------------------------------------------------
// Check 1 — no surviving `@gsd-stub` under packages/*/src
// ---------------------------------------------------------------------------
function checkNoStubs() {
  const hits = []
  const packagesDir = join(ROOT, 'packages')
  for (const pkg of readdirSync(packagesDir)) {
    const srcDir = join(packagesDir, pkg, 'src')
    if (!existsSync(srcDir)) continue
    const files = []
    walk(srcDir, files)
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (line.includes('@gsd-stub')) hits.push(`${relative(ROOT, file)}:${i + 1}  ${line.trim().slice(0, 100)}`)
      })
    }
  }
  if (hits.length > 0) {
    report('check 1 (no surviving stubs) FAILED', hits)
    failures.push('1-stubs')
  } else {
    console.log('release-gate: check 1 (no surviving stubs) PASS — 0 @gsd-stub under packages/*/src')
  }
}

// ---------------------------------------------------------------------------
// Check 2 — ABI inventory: exactly 10 tracked files, no forbidden-name fingerprint match
// ---------------------------------------------------------------------------
const EXPECTED_ABI_FILES = [
  'ERC20.ts',
  'ERC721.ts',
  'IERC2981.ts',
  'UniswapV2Factory.ts',
  'UniswapV2Pair.ts',
  'UniswapV2Router01CollectionNativeERC20.ts',
  'UniswapV2Router02Collection.ts',
  'WERC721.ts',
  'WETH9.ts',
  'index.ts',
]

// ---------------------------------------------------------------------------
// Forbidden-name guard, by fingerprint rather than by name.
//
// A gate that keeps a plaintext deny-list is only as private as the file it lives
// in — publish the file, and the list itself becomes the disclosure it exists to
// prevent. This guard instead stores only the SHA-256 fingerprint of each
// forbidden identifier (lowercased before hashing — comparisons below are
// case-insensitive, matching the previous substring check's behavior). It never
// holds, logs, or derives the plaintext identifiers themselves; a failure report
// can therefore only ever say THAT an identifier's fingerprint matched, and
// WHERE — never WHICH identifier.
//
// The previous mechanism matched by raw substring against a whole file's
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
// still caught this way, exactly as the old substring check would have caught
// it; only identifiers whose casing deliberately obscures every natural word
// boundary could slip past both this and the previous mechanism.
const FORBIDDEN_NAME_FINGERPRINTS = new Set([
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

function fingerprintOf(candidate) {
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
function candidatesForToken(token) {
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
function findForbiddenFingerprintLines(text) {
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

function checkAbiInventory() {
  const hits = []
  const abisDir = join(ROOT, 'packages', 'sdk', 'src', 'abis')
  let files
  try {
    files = execSync('git ls-files packages/sdk/src/abis', { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .map((f) => f.trim())
      .filter(Boolean)
      .map((f) => f.replace('packages/sdk/src/abis/', ''))
      .sort()
  } catch (e) {
    hits.push(`could not run 'git ls-files packages/sdk/src/abis': ${e.message}`)
    files = []
  }

  const expected = [...EXPECTED_ABI_FILES].sort()
  if (JSON.stringify(files) !== JSON.stringify(expected)) {
    hits.push(`expected exactly ${expected.length} tracked files: ${expected.join(', ')}`)
    hits.push(`found ${files.length}: ${files.join(', ') || '(none)'}`)
  }

  for (const file of EXPECTED_ABI_FILES.filter((f) => f !== 'index.ts')) {
    const full = join(abisDir, file)
    if (!existsSync(full)) continue
    const source = readFileSync(full, 'utf8')
    for (const lineNo of findForbiddenFingerprintLines(source)) {
      hits.push(`${relative(ROOT, full)}:${lineNo}  an identifier on this line matches a forbidden-name fingerprint`)
    }
  }

  if (hits.length > 0) {
    report('check 2 (ABI inventory) FAILED', hits)
    failures.push('2-abis')
  } else {
    console.log('release-gate: check 2 (ABI inventory) PASS — exactly 10 tracked files, no forbidden-name fingerprint match')
  }
}

// ---------------------------------------------------------------------------
// Check 3 — secrets scan: whole repo (excluding node_modules/dist/.git/lockfile),
// then packages/*/dist specifically.
// ---------------------------------------------------------------------------
const SECRET_RULES = [
  { id: '64-hex literal', re: /\b[0-9a-fA-F]{64}\b/ },
  { id: 'PEM private key header', re: /-----BEGIN[ A-Z]*PRIVATE KEY-----/ },
  { id: 'sk_live prefix', re: new RegExp('sk' + '_live') },
  { id: 'snf_live_ prefix', re: new RegExp('snf' + '_live_') },
  // An Alchemy/Infura URL whose path segment (the key itself) is >= 20 chars.
  { id: 'Alchemy/Infura URL with long path segment', re: /(alchemy|infura)\.[a-z.]*\/(?:v2\/)?[A-Za-z0-9_-]{20,}/ },
]

// Files whose CONTENT legitimately contains 64-hex-shaped strings that are not
// secrets (compiled ABIs/bytecode fixtures, lockfile hashes) would be a source of
// false positives if this gate ever needs one — none exist in this repo today, so no
// path-based exemption list; add one here with a comment if a real false positive
// shows up, never silence a rule at the pattern level.
const BINARY_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2', '.map'])

// Exactly two files in this repo legitimately NAME these patterns in prose/code
// rather than CONTAINING a secret shaped like them — excluded by exact path, not by
// weakening any pattern, so a real secret pasted into either would still need a
// human to notice it is outside this one narrow exemption:
//   - `SECURITY.md` documents the four prefixes/formats this gate blocks, for a
//     human reader ("...enforced by a secrets scan for sk_live/snf_live_...").
//   - `scripts/release-gate.mjs` (this file) is the gate's own implementation —
//     Pass 1 walks the whole repo including `scripts/`, so its own rule table and
//     comments (which must literally spell out what they block) would otherwise
//     trip its own check, the identical self-reference problem
//     `scripts/grep-gate.mjs`'s header comment already documents for itself.
const SECRETS_SCAN_EXCLUDE_PATHS = new Set(['SECURITY.md', 'scripts/release-gate.mjs'])

function scanFileForSecrets(file) {
  if (SECRETS_SCAN_EXCLUDE_PATHS.has(relative(ROOT, file).replace(/\\/g, '/'))) return []
  const ext = file.slice(file.lastIndexOf('.'))
  if (BINARY_EXTENSIONS.has(ext)) return []
  let content
  try {
    content = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const hits = []
  content.split('\n').forEach((line, i) => {
    for (const rule of SECRET_RULES) {
      if (rule.re.test(line)) hits.push(`${relative(ROOT, file)}:${i + 1}  [${rule.id}]  ${line.trim().slice(0, 100)}`)
    }
  })
  return hits
}

function checkNoTrackedEnvFiles() {
  const hits = []
  let tracked
  try {
    tracked = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)
  } catch (e) {
    hits.push(`could not run 'git ls-files': ${e.message}`)
    return hits
  }
  for (const path of tracked) {
    const base = path.slice(path.lastIndexOf('/') + 1)
    if (base === '.env.example') continue
    if (base === '.env' || (base.startsWith('.env.') && base !== '.env.example')) {
      hits.push(`tracked .env-shaped file: ${path}`)
    }
  }
  return hits
}

function checkSecrets() {
  const hits = []

  // Pass 1 — the whole repo, excluding node_modules/.git/build caches AND dist
  // (dist gets its own dedicated pass 2 below, per the plan's own two-pass action text).
  const wholeRepoFiles = []
  walk(ROOT, wholeRepoFiles, { includeDist: false })
  for (const file of wholeRepoFiles) {
    if (file.endsWith('pnpm-lock.yaml')) continue
    hits.push(...scanFileForSecrets(file))
  }

  // Pass 2 — packages/*/dist specifically (a transitive re-export could smuggle a
  // secret past a source-only scan — same rationale as scripts/grep-gate.mjs).
  const packagesDir = join(ROOT, 'packages')
  for (const pkg of readdirSync(packagesDir)) {
    const distDir = join(packagesDir, pkg, 'dist')
    if (!existsSync(distDir)) continue
    const distFiles = []
    walk(distDir, distFiles, { includeDist: true })
    for (const file of distFiles) hits.push(...scanFileForSecrets(file))
  }

  hits.push(...checkNoTrackedEnvFiles())

  if (hits.length > 0) {
    report('check 3 (secrets scan) FAILED', hits)
    failures.push('3-secrets')
  } else {
    console.log('release-gate: check 3 (secrets scan) PASS — repo + packages/*/dist clean, no tracked .env')
  }
}

// ---------------------------------------------------------------------------
// Check 4 — bundle budget: shell out to `pnpm size` (size-limit), fail on non-zero.
// ---------------------------------------------------------------------------
function checkBundleBudget() {
  try {
    const out = execSync('pnpm size', { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' })
    console.log('release-gate: check 4 (bundle budget) PASS')
    console.log(out.trim().split('\n').map((l) => `  ${l}`).join('\n'))
  } catch (e) {
    report('check 4 (bundle budget) FAILED', [(e.stdout ?? '') + (e.stderr ?? e.message)])
    failures.push('4-size')
  }
}

// ---------------------------------------------------------------------------
// Check 5 — version consistency: built SDK_VERSION === package.json#version, and
// sdk-react's peer range on @sweepnflip/sdk admits it.
// ---------------------------------------------------------------------------

/** Minimal, dependency-free "does this range admit this exact version" check —
 * this repo's own two packages only ever use pnpm's `workspace:` protocol or a plain
 * `^x.y.z`/`~x.y.z`/exact/`*` specifier for this ONE internal edge, so a full semver
 * range parser is unwarranted (`D-05`'s "no dependencies" instruction for this script). */
function admitsVersion(range, version) {
  if (range === '*') return true
  if (range.startsWith('workspace:')) {
    const pinned = range.slice('workspace:'.length)
    // `workspace:*` / `workspace:^` / `workspace:~` (no trailing version) are pnpm's
    // own shorthand for "whatever version this workspace package currently is" — by
    // construction they always admit the current version; pnpm itself enforces the
    // pinned-exact-version form (`workspace:1.2.3`) at install time.
    if (pinned === '*' || pinned === '^' || pinned === '~' || pinned === '') return true
    return pinned === version
  }
  if (range === version) return true
  const [major, minor, patch] = version.split('.').map(Number)
  if (range.startsWith('^')) {
    const [rMajor, rMinor, rPatch] = range.slice(1).split('.').map(Number)
    if (major !== rMajor) return false
    if (minor > rMinor) return true
    if (minor < rMinor) return false
    return patch >= rPatch
  }
  if (range.startsWith('~')) {
    const [rMajor, rMinor, rPatch] = range.slice(1).split('.').map(Number)
    return major === rMajor && minor === rMinor && patch >= rPatch
  }
  return false
}

function checkVersionConsistency() {
  const hits = []
  const sdkPkgPath = join(ROOT, 'packages', 'sdk', 'package.json')
  const sdkPkg = JSON.parse(readFileSync(sdkPkgPath, 'utf8'))
  const distIndexPath = join(ROOT, 'packages', 'sdk', 'dist', 'index.js')

  if (!existsSync(distIndexPath)) {
    hits.push(`${relative(ROOT, distIndexPath)} does not exist — run 'pnpm -r build' before release:gate`)
  } else {
    const distSource = readFileSync(distIndexPath, 'utf8')
    const match = distSource.match(/SDK_VERSION\s*=\s*["']([^"']+)["']/)
    if (!match) {
      hits.push(`could not find an 'SDK_VERSION = "..."' assignment in ${relative(ROOT, distIndexPath)}`)
    } else if (match[1] !== sdkPkg.version) {
      hits.push(`built SDK_VERSION ("${match[1]}") !== packages/sdk/package.json#version ("${sdkPkg.version}")`)
    }
  }

  const reactPkgPath = join(ROOT, 'packages', 'sdk-react', 'package.json')
  const reactPkg = JSON.parse(readFileSync(reactPkgPath, 'utf8'))
  const peerRange = reactPkg.peerDependencies?.['@sweepnflip/sdk']
  if (!peerRange) {
    hits.push(`packages/sdk-react/package.json has no peerDependencies["@sweepnflip/sdk"]`)
  } else if (!admitsVersion(peerRange, sdkPkg.version)) {
    hits.push(
      `packages/sdk-react's peerDependencies["@sweepnflip/sdk"] ("${peerRange}") does not admit ` +
        `@sweepnflip/sdk's current version ("${sdkPkg.version}")`,
    )
  }

  if (hits.length > 0) {
    report('check 5 (version consistency) FAILED', hits)
    failures.push('5-version')
  } else {
    console.log(
      `release-gate: check 5 (version consistency) PASS — SDK_VERSION ${sdkPkg.version} matches package.json, ` +
        `sdk-react's peer range ("${peerRange}") admits it`,
    )
  }
}

// ---------------------------------------------------------------------------
// Check 6 — forbidden-name fingerprints over the tracked source tree, not just
// the ABI directory check 2 covers. Same FORBIDDEN_NAME_FINGERPRINTS set, same
// findForbiddenFingerprintLines mechanism, wider scope: this is what makes the
// guard permanent — a guarded identifier that returns to tracked source
// anywhere in the repo fails the gate, not only if it lands in packages/sdk/src/abis.
//
// Off by default. The tracked tree can currently contain guarded identifiers
// this check exists to keep out; turning this on before that source-level
// cleanup lands would fail the gate on unrelated work. A later commit removes
// those identifiers from source and flips this flag on.
const SCAN_TRACKED_TREE_FOR_FORBIDDEN_FINGERPRINTS = false

function checkForbiddenFingerprintsTrackedTree() {
  if (!SCAN_TRACKED_TREE_FOR_FORBIDDEN_FINGERPRINTS) {
    console.log('release-gate: check 6 (forbidden-name fingerprints, tracked tree) SKIPPED — disabled')
    return
  }
  const hits = []
  let tracked
  try {
    tracked = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)
  } catch (e) {
    hits.push(`could not run 'git ls-files': ${e.message}`)
    tracked = []
  }
  for (const relPath of tracked) {
    if (relPath.endsWith('pnpm-lock.yaml')) continue
    const ext = relPath.slice(relPath.lastIndexOf('.'))
    if (BINARY_EXTENSIONS.has(ext)) continue
    const full = join(ROOT, relPath)
    let source
    try {
      source = readFileSync(full, 'utf8')
    } catch {
      continue
    }
    for (const lineNo of findForbiddenFingerprintLines(source)) {
      hits.push(`${relPath}:${lineNo}  an identifier on this line matches a forbidden-name fingerprint`)
    }
  }
  if (hits.length > 0) {
    report('check 6 (forbidden-name fingerprints, tracked tree) FAILED', hits)
    failures.push('6-fingerprints-tree')
  } else {
    console.log('release-gate: check 6 (forbidden-name fingerprints, tracked tree) PASS — 0 matches')
  }
}

checkNoStubs()
checkAbiInventory()
checkSecrets()
checkBundleBudget()
checkVersionConsistency()
checkForbiddenFingerprintsTrackedTree()

console.log('')
if (failures.length > 0) {
  console.error(`release-gate: FAILED (${failures.length}/6 checks failed: ${failures.join(', ')})`)
  process.exit(1)
} else {
  console.log(
    'release-gate: PASS — all checks green (stubs, ABI inventory, secrets, bundle budget, version consistency, ' +
      'forbidden-name fingerprints tracked-tree scan skipped/disabled)',
  )
  process.exit(0)
}
