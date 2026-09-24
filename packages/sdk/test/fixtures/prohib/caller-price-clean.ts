/**
 * `caller-price-clean.ts` — the compliant reference for the rule that no
 * caller-supplied price may ever reach `bounds`/`value`/`amountOutMin`.
 *
 * This literally RE-EXPORTS the real `deriveBounds` (`src/build/bounds.ts`) rather
 * than re-implementing it — the real function already structurally ignores any
 * `callerQuote` field a caller attaches to its args object (its own `DeriveBoundsArgs`
 * type never declares one, and a plain JS function simply does not read an unused
 * property), so it IS its own "clean fixture": calling it with a tampered
 * `callerQuote` attached produces the exact same `Bounds` as calling it without one.
 * `test/prohibitions/no-caller-price.test.ts`'s causation-control block exploits this
 * directly — pointing `SNF_SDK_PROHIB_SUBJECT` at this file changes nothing, which is the
 * whole point of a "clean" control.
 */
export { deriveBounds } from '../../../src/build/bounds'
