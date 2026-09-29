/**
 * Attribution barrel — ERC-8021 (schema 0) partner attribution. The public helpers
 * are `encodeAttribution`, `parseAttribution`, `validatePartnerCode` and `toSdkCode`;
 * the client applies the suffix itself (see `sdkSuffix.ts`).
 */
export { encodeAttribution, parseAttribution } from './erc8021'
export { toSdkCode, validatePartnerCode } from './codes'
