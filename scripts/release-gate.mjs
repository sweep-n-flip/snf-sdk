#!/usr/bin/env node
// scripts/release-gate.mjs
//
// snf-54-20 (R21, REQ-SDK-01, REQ-SDK-52). One command, five checks, non-zero exit and
// a readable report on ANY failure:
//
//   1. No surviving stubs      — `@gsd-stub` must not appear anywhere under packages/*/src
//   2. ABI inventory           — packages/sdk/src/abis holds exactly the audited set,
//                                 no forbidden non-AMM product name anywhere in it
//   3. Secrets scan            — the whole repo, then packages/*/dist, clean of any
//                                 private-key/API-key-shaped literal or a tracked .env
//   4. Bundle budget            — `pnpm size` (size-limit) exits 0
//   5. Version consistency      — built SDK_VERSION === package.json#version, and
//                                 sdk-react's peer range on @sweepnflip/sdk admits it
//
// Deliberately zero npm dependencies (D-05/D-06 spirit: nothing in this repo's own
// tooling should need a registry fetch to gate a release) — only Node's `node:fs`,
// `node:path` and one `node:child_process` shell-out to the existing `pnpm size`
// script (check 4 composes that check rather than re-implementing size-limit's own
// gzip math).
import { execSync } from 'node:child_process'
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
// Check 2 — ABI inventory: exactly 10 tracked files, no forbidden product name
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

// Superset of the plan's own list plus `packages/sdk/test/abis/inventory.test.ts`'s
// list (`SnFRouter`, `Conduit`) — a release gate should be at least as strict as the
// unit test it complements, never looser.
const FORBIDDEN_PRODUCT_NAMES = [
  'AdvancedRouter',
  'SnFRouter',
  'SnFQuoter',
  'swapNFTsForNFTs',
  'Farm',
  'StakingPool',
  'Bridge',
  'Axelar',
  'MktBids',
  'Vault',
  'Seaport',
  'Conduit',
]

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
    const lower = source.toLowerCase()
    for (const name of FORBIDDEN_PRODUCT_NAMES) {
      if (lower.includes(name.toLowerCase())) hits.push(`${relative(ROOT, full)} contains forbidden product name "${name}"`)
    }
  }

  if (hits.length > 0) {
    report('check 2 (ABI inventory) FAILED', hits)
    failures.push('2-abis')
  } else {
    console.log('release-gate: check 2 (ABI inventory) PASS — exactly 10 tracked files, no forbidden product name')
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

checkNoStubs()
checkAbiInventory()
checkSecrets()
checkBundleBudget()
checkVersionConsistency()

console.log('')
if (failures.length > 0) {
  console.error(`release-gate: FAILED (${failures.length}/5 checks failed: ${failures.join(', ')})`)
  process.exit(1)
} else {
  console.log('release-gate: PASS — all 5 checks green (stubs, ABI inventory, secrets, bundle budget, version consistency)')
  process.exit(0)
}
