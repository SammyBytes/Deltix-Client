import { createVersioningService } from '../../contexts/versioning';
import { normalizeTables } from '../helpers/args';
import { handleVersioningError } from '../helpers/handle-versioning-error';
import { resolveRepo } from '../helpers/repo';
import { printError, printKeyValues, printSuccess } from '../output';

async function runSyncPrefsGet(
  service: ReturnType<typeof createVersioningService>,
  repoArg: string | undefined,
): Promise<number> {
  const repo = await resolveRepo(repoArg, 'Usage: deltix sync-prefs get <repo>');
  if (!repo) return 1;
  const preference = await service.getSyncPreferences(repo);
  printKeyValues((preference ?? {}) as Record<string, unknown>);
  return 0;
}

async function runSyncPrefsSet(
  service: ReturnType<typeof createVersioningService>,
  repoArg: string | undefined,
  mode: string | undefined,
  tables: string[],
): Promise<number> {
  const repo = await resolveRepo(
    repoArg,
    'Usage: deltix sync-prefs set <repo> <schema-only|schema-and-data> [tables...]',
  );
  if (!repo || !mode || !['schema-only', 'schema-and-data'].includes(mode)) return 1;
  const preference = await service.setSyncPreferences(
    repo,
    mode === 'schema-only' ? 'schema_only' : 'schema_and_data',
    normalizeTables(tables),
  );
  printSuccess(
    `Sync preferences updated for ${repo}`,
    preference as unknown as Record<string, unknown>,
  );
  return 0;
}

async function runSyncPrefsDryRun(
  service: ReturnType<typeof createVersioningService>,
  repoArg: string | undefined,
  mode: string | undefined,
  tables: string[],
): Promise<number> {
  const repo = await resolveRepo(repoArg, 'Usage: deltix sync-prefs dry-run <repo> [tables...]');
  if (!repo) return 1;
  const requestedTables = mode ? [mode, ...tables] : tables;
  // Honor the previously saved sync-preference mode instead of silently
  // forcing schema_and_data — a stored schema_only preference must not be
  // overridden by a dry-run preview.
  const stored = await service.getSyncPreferences(repo);
  const dryRunMode = stored?.mode ?? 'schema_and_data';
  const plan = await service.dryRunSyncPreferences(
    repo,
    dryRunMode,
    normalizeTables(requestedTables),
  );
  printKeyValues(plan as unknown as Record<string, unknown>);
  return 0;
}

export async function runSyncPrefs(args: string[]): Promise<number> {
  const [action, repoArg, mode, ...tables] = args;
  if (!action) {
    printError('Usage: deltix sync-prefs <get|set|dry-run> [repo] [mode] [tables...]');
    return 1;
  }

  try {
    const service = createVersioningService();
    switch (action) {
      case 'get':
        return runSyncPrefsGet(service, repoArg);
      case 'set':
        return runSyncPrefsSet(service, repoArg, mode, tables);
      case 'dry-run':
        return runSyncPrefsDryRun(service, repoArg, mode, tables);
      default:
        printError('Usage: deltix sync-prefs <get|set|dry-run> [repo] [mode] [tables...]');
        return 1;
    }
  } catch (err) {
    return handleVersioningError(err, 'Sync preferences command failed');
  }
}
