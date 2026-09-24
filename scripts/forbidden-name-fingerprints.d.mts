// Type declarations for forbidden-name-fingerprints.mjs — a plain ESM script, not
// part of any package's build, but imported by packages/sdk/test/abis/inventory.test.ts
// so both consumers share one fingerprint set and one matching implementation.
export declare const FORBIDDEN_NAME_FINGERPRINTS: ReadonlySet<string>
export declare function fingerprintOf(candidate: string): string
export declare function candidatesForToken(token: string): Set<string>
export declare function findForbiddenFingerprintLines(text: string): number[]
export declare function containsForbiddenName(text: string): boolean
