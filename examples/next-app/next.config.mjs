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

// snf-sdk's own pnpm-lock.yaml (this repo's workspace root) sits two directories up
// from here. The parent snf-workspace checkout has ANOTHER lockfile further up the
// tree, which Turbopack's auto-detection picks by default, then warns about the
// ambiguity — pinning `root` explicitly names the correct one (this repo, not the
// unrelated workspace it happens to be checked out inside of).
const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url))

const nextConfig = {
  reactStrictMode: true,
  turbopack: {
    root: workspaceRoot,
  },
}

export default nextConfig
