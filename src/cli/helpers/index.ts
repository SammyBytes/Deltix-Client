/**
 * Barrel module for CLI helpers.
 * Exports pure functions so commands stay thin and testable.
 */

export { splitPositionalsAndFlags, flagValue, parseFlagValue, normalizeTables } from './args';
export { branchUsage, logMergeConflict, resolveRepo, resolveRepoAndName, resolveServerIdentity } from './repo';
export { newLocalService } from './newLocalService';
export { handleSyncError } from './handle-sync-error';
