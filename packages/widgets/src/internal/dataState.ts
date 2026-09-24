/**
 * `toDataAttrs` — converts a plain object of primitive state/identity values into
 * `data-*` attribute keys a partner can style against with pure CSS, no JavaScript
 *. Nothing this function touches may ever be a color, size, spacing or
 * font value — it carries STATE and IDENTITY only (`data-snf-part`, `data-state`,
 * `data-side`, `data-step-kind`, `data-busy`, `data-disabled`), never a visual
 * decision. Every later plan's `data-*` vocabulary goes through this one function so
 * that guarantee has one implementation to audit, not N.
 *
 * Drops any key whose value is `undefined`. Stringifies what remains: booleans become
 * the literal `"true"`/`"false"`, numbers become `String(n)`, strings pass through
 * as-is. Converts each key from camelCase to a `data-*` attribute name
 * (`stepKind` -> `data-step-kind`).
 */
export function toDataAttrs(
  map: Readonly<Record<string, string | number | boolean | undefined>>,
): Record<string, string> {
  const attrs: Record<string, string> = {}
  for (const key of Object.keys(map)) {
    const value = map[key]
    if (value === undefined) continue
    attrs[toDataAttrName(key)] = String(value)
  }
  return attrs
}

/** camelCase -> `data-kebab-case` (`stepKind` -> `data-step-kind`). */
function toDataAttrName(key: string): string {
  return `data-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`
}
