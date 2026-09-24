/**
 * `mergeClassNames` — the ONLY place two class strings are combined anywhere in this
 * package. Every part calls this instead of template-literal-concatenating
 * classes inline, so the "partner's class always survives" guarantee has one
 * implementation to audit, not N.
 *
 * Filters out falsy entries (`undefined`, `false`, `''`), joins the survivors with a
 * single space, and returns `undefined` — never `''` — when nothing survives, so a
 * consumer never renders a stray `className=""`.
 */
export function mergeClassNames(...values: ReadonlyArray<string | undefined | false>): string | undefined {
  const survivors = values.filter((value): value is string => Boolean(value))
  return survivors.length > 0 ? survivors.join(' ') : undefined
}
