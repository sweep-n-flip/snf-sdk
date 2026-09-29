/**
 * ERC-8021 attribution config for `createSnfClient`.
 *
 * Attribution is always on: every transaction the client builds for an SnF contract
 * (never an approval) ends with an ERC-8021 schema-0 suffix naming the channel —
 * `sdk` without a partner code, `sdk-<code>` with one. Contracts ignore the trailing
 * bytes; indexers read them. No registration is needed to tag.
 */
export interface AttributionConfig {
  /**
   * Your partner code, for example `'acme'` (emitted as `sdk-acme`; passing
   * `'sdk-acme'` is equivalent). Lowercase letters, digits and `-`, starting with a
   * letter or digit, 2–28 chars. `snf`, `snf-*` and a bare `sdk` are reserved. A bad
   * code throws `INVALID_PARAMS` from `createSnfClient`, never at send time.
   */
  readonly code?: string | undefined
}
