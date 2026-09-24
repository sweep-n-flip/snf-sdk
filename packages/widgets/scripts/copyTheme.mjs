#!/usr/bin/env node
// scripts/copyTheme.mjs
//
// Places the optional SnF theme (`src/theme.css` — plain CSS custom properties plus
// the `data-part`-scoped rules that consume them) into `dist/theme.css` as
// part of this package's build. tsup does not process raw CSS on its own, and
// `theme.css` needs no transpilation (plain, static CSS with custom properties, which
// every target browser this package supports already understands natively), so this
// step is a plain file copy, not a bundler pass — no new dependency.
//
// MUST run AFTER `tsup` (see package.json's `build` script: `tsup && node
// scripts/copyTheme.mjs`) — tsup's own `clean: true` removes `dist/` before it runs,
// so copying first would have this script's own output deleted out from under it.
import { cpSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(scriptDir, '..')
const src = join(packageRoot, 'src', 'theme.css')
const destDir = join(packageRoot, 'dist')
const dest = join(destDir, 'theme.css')

// tsup's `clean: true` may or may not have left `dist/` present depending on script
// ordering — create it defensively rather than assume tsup already did.
mkdirSync(destDir, { recursive: true })
cpSync(src, dest)

console.log(`copied ${src} -> ${dest}`)
