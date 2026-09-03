/**
 * Barrel module for CLI helpers.
 * Exports pure functions so commands stay thin and testable.
 */

export { flagValue, normalizeTables, parseFlagValue, splitPositionalsAndFlags } from './args';
export { handleSyncError } from './handle-sync-error';
export { newLocalService } from './newLocalService';
export {
  branchUsage,
  logMergeConflict,
  resolveRepo,
  resolveRepoAndName,
  resolveServerIdentity,
} from './repo';
