/**
 * `cap-royalty-violation.ts` — the DELIBERATE anti-pattern the
 * cap-royalty-pinned rule forbids, kept ONLY as a test subject for
 * `test/prohibitions/cap-royalty-pinned.test.ts` (`SNF_SDK_PROHIB_SUBJECT`). MUST NEVER
 * be imported by `src/` (see `caller-price-violation.ts`'s identical header note).
 *
 * The rule forbids BOTH sending `capRoyaltyFee=true` AND merely offering a switch a
 * partner could flip — this fixture is the second half of that: it exposes exactly
 * such a switch, defaulting to `false` so a naive smoke-test might miss it, but a
 * caller who passes `{ capRoyaltyFee: true }` gets it echoed straight through. With
 * `royaltyFeeCap` unset (0 = no cap on-chain), the Router would then pay the
 * creator NOTHING for that call.
 */
export function resolveCapRoyaltyFee(options?: { readonly capRoyaltyFee?: boolean }): boolean {
  // THE VIOLATION: exposes a flag the rule says must not exist at all, not just
  // default it safely.
  return options?.capRoyaltyFee ?? false
}
