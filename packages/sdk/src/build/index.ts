/**
 * The shared build machinery every `build*` function (plan 15's `buildBuy`,
 * `buildSell`, `buildNftToNft`, `buildSwap`) composes — bounds, validation, approval
 * pre-checks, gas, step assembly, and the pre-flight (R13, R14; 54-SPEC.md).
 *
 * Deliberately does NOT re-export `buildBuy`/`buildSell`/`buildNftToNft`/`buildSwap`
 * themselves — `client.ts` imports each of those directly from its own module, and
 * this barrel exists for the machinery underneath them, not the four public builders.
 */
export * from './bounds'
export * from './validate'
export * from './approvals'
export * from './gas'
export * from './plan'
export * from './preflight'
