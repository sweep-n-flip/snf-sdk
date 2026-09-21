/**
 * `cap-royalty-clean.ts` — the compliant reference for SPEC prohibition #7
 * (`capRoyaltyFee` is pinned `false` in v1; no public API may expose a flag that
 * could flip it).
 *
 * Unlike the other four fixture-backed prohibitions, this one has NO standalone
 * exported "decision function" to re-export from `src/` — `capRoyaltyFee` is pinned
 * by INLINING the literal `false` at each of the three `*Collection` encode call
 * sites (`src/build/buildBuy.ts`, `buildSell.ts`, `buildNftToNft.ts` — both legs —
 * and `src/quote/quoteContext.ts`'s own `getAmountsIn/OutCollection` reads), by
 * design: there is nothing to parameterise because there is no parameter. This file
 * IS therefore the canonical reference implementation of the rule (`resolveCap`
 * always returns the literal `false`, ignoring anything the caller passes) — it is
 * what `test/prohibitions/cap-royalty-pinned.test.ts`'s `GSD_PROHIB_SUBJECT` block
 * defaults to. The test file's OTHER, non-subject assertions decode REAL calldata
 * from `buildBuy`/`buildSell`/`buildNftToNft` directly, which is the authoritative
 * proof this prohibition holds against production code today.
 */
export function resolveCapRoyaltyFee(_options?: { readonly capRoyaltyFee?: boolean }): boolean {
  void _options
  return false
}
