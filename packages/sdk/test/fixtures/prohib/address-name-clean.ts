/**
 * `address-name-clean.ts` — the compliant reference for SPEC prohibition #6 (an
 * address, full or shortened, is never a collection name). Re-exports the real
 * `getCollectionLabels` (`src/collection/labels.ts`) verbatim.
 */
export { getCollectionLabels } from '../../../src/collection/labels'
