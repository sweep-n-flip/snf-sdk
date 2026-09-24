/**
 * examples/next-app/next.config.mjs
 *
 * Deliberately minimal — this example is a wiring reference, not a product.
 * No custom webpack/turbopack config, no rewrites, no image domains: nothing here
 * needs a bundler tweak to run this app's four sections (collection, inventory,
 * quote, checkout).
 *
 * @type {import('next').NextConfig}
 */
import { fileURLToPath } from 'node:url'

// This repo's own pnpm-lock.yaml (its workspace root) sits two directories up
// from here. If this repo is checked out nested inside a larger directory tree that
// also has a lockfile further up, Turbopack's auto-detection can pick that outer one
// by default and then warn about the ambiguity — pinning `root` explicitly names the
// correct one (this repo, not whatever unrelated tree it happens to be checked out
// inside of).
const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url))

const nextConfig = {
  reactStrictMode: true,
  turbopack: {
    root: workspaceRoot,
  },
}

export default nextConfig
