/**
 * Routing surface — `path[]` construction, wNFT
 * unit scaling, Gate 69.5 direct-only gating, and the typed no-route reason. Not
 * re-exported from the package root (`src/index.ts`) yet — `createSnfClient`
 * is the documented partner surface; this barrel is for internal
 * `quote`/`build` module consumption.
 */
export * from './routing.types'
export * from './nftRoutePaths'
export * from './wnftPathScale'
export * from './directOnlyRouting'
export * from './routeBlock'
