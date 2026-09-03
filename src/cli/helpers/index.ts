/**
 * Barrel module for CLI helpers.
 * Exports pure functions so commands stay thin and testable.
 */

export { flagValue, normalizeTables, parseFlagValue, splitPositionalsAndFlags } from './args';
export { handleLocalServerError } from './handle-local-server-error';
export { handleSyncError } from './handle-sync-error';
export { handleVersioningError } from './handle-versioning-error';
export { newLocalService } from './newLocalService';
export { persistLocalPortIfExplicit } from './persist-local-port';
export {
  branchUsage,
  logMergeConflict,
  resolveRepo,
  resolveRepoAndName,
  resolveServerIdentity,
} from './repo';
