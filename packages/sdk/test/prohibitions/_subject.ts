import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

/**
 * `resolveSubject` — the `GSD_PROHIB_SUBJECT` convention every prohibition test in
 * this directory uses to select which implementation it exercises (the
 * `check_violation_fixture`/`check_clean_fixture` causation-control contract).
 *
 * `GSD_PROHIB_SUBJECT` accepts exactly the three values the documented prohibition
 * descriptors name, all resolved RELATIVE TO `packages/sdk/` (matching the same
 * `check_target`/`check_violation_fixture`/`check_clean_fixture` path convention —
 * e.g. `test/fixtures/prohib/caller-price-violation.ts`):
 *
 * - unset -> `defaultPath` (the REAL production module this
 * prohibition governs — see each test file's own header
 * for exactly which export is exercised and why calling
 * it with an extra, real-module-ignored field is what
 * makes the "default is the real module" claim literal
 * rather than aspirational).
 * - a clean fixture -> must behave IDENTICALLY to the real module (GREEN).
 * - a violation fixture -> must DIVERGE from the real module's guarantee (RED).
 *
 * `import()`ing a `.ts` path directly works here because vitest's own vite transform
 * pipeline compiles any module reachable from a test file's module graph — including
 * one reached via a *dynamic* `import()` at test-run time, not only a static one —
 * so this is never a raw Node `import()` of untranspiled TypeScript.
 *
 * A runner points this env var at a fixture like so (both shells — no `cross-env`
 * needed since the test itself reads `process.env`, not a shell-substituted CLI arg):
 * PowerShell : `$env:GSD_PROHIB_SUBJECT = "test/fixtures/prohib/X-violation.ts"; pnpm ... vitest run test/prohibitions/Y.test.ts`
 * Git Bash : `GSD_PROHIB_SUBJECT=test/fixtures/prohib/X-violation.ts pnpm ... vitest run test/prohibitions/Y.test.ts`
 */

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

export async function resolveSubject<T = Record<string, unknown>>(defaultPath: string): Promise<T> {
  const envPath = process.env.GSD_PROHIB_SUBJECT
  const relative = envPath && envPath.trim().length > 0 ? envPath.trim() : defaultPath
  const absolute = path.isAbsolute(relative) ? relative : path.resolve(PACKAGE_ROOT, relative)
  return (await import(pathToFileURL(absolute).href)) as T
}

/** Human-readable descriptor of what `resolveSubject` actually resolved to, for
 * assertion failure messages and for the SUMMARY's run-matrix transcription. */
export function describeSubject(defaultPath: string): string {
  const envPath = process.env.GSD_PROHIB_SUBJECT
  return envPath && envPath.trim().length > 0 ? envPath.trim() : `${defaultPath} (default: real module)`
}
