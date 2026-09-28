import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Proves the narrowed gate's own acceptance criterion against the PUBLISHED
 * artifacts, not just the source: no built file in any of the three packages'
 * `dist` contains the SnF backend path, and — so this isn't a vacuously-true check —
 * at least one built core file DOES contain the public app origin, proving `appLinks`
 * actually reached the bundle.
 *
 * Requires `pnpm -r build` to have run first, exactly like
 * `test/release/surface.test.ts`'s own precondition.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
// packages/sdk/test/release -> packages/sdk -> packages -> repo root
const ROOT = resolve(HERE, '../../../..')

const DIST_DIRS = [
  { name: '@sweepnflip/sdk', dir: resolve(ROOT, 'packages/sdk/dist') },
  { name: '@sweepnflip/sdk-react', dir: resolve(ROOT, 'packages/sdk-react/dist') },
  { name: '@sweepnflip/widgets', dir: resolve(ROOT, 'packages/widgets/dist') },
]

function walkNonMapFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      walkNonMapFiles(full, out)
    } else if (!entry.endsWith('.map')) {
      out.push(full)
    }
  }
}

describe('no built artifact contains the SnF backend path', () => {
  for (const { name, dir } of DIST_DIRS) {
    it(`${name}'s dist has no file containing "sweepnflip.io/api" (run "pnpm -r build" first)`, () => {
      expect(existsSync(dir), `missing ${dir} — run "pnpm -r build" first`).toBe(true)

      const files: string[] = []
      walkNonMapFiles(dir, files)
      expect(files.length, `${dir} contains no built files`).toBeGreaterThan(0)

      const offenders = files.filter((file) => readFileSync(file, 'utf8').includes('sweepnflip.io/api'))
      expect(offenders).toEqual([])
    })
  }

  it('the core dist DOES contain the app origin (anti-vacuity: appLinks actually reached the bundle)', () => {
    const dir = resolve(ROOT, 'packages/sdk/dist')
    expect(existsSync(dir), `missing ${dir} — run "pnpm -r build" first`).toBe(true)

    const files: string[] = []
    walkNonMapFiles(dir, files)

    const carriers = files.filter((file) =>
      readFileSync(file, 'utf8').includes('https://app.sweepnflip.io'),
    )
    expect(carriers.length).toBeGreaterThan(0)
  })
})
