/**
 * Git-style working-tree maintenance on the local Dolt data dir:
 *
 * - `deltix reset [<repo>] [--hard]` — mixed: unstages staged changes while
 *   keeping working values; `--hard`: discards every uncommitted change and
 *   reverts the working tree to the current branch HEAD (git reset --hard).
 * - `deltix clean [<repo>] [--dry-run|-n]` — permanently deletes untracked
 *   tables from the working set (git clean); `--dry-run` only lists them.
 *
 * Both operate on the local repo only, with or without the local sql-server
 * running, and never touch the remote.
 */
import { handleVersioningError } from '../helpers/handle-versioning-error';
import { newLocalService } from '../helpers/newLocalService';
import { resolveRepo, resolveServerIdentity } from '../helpers/repo';
import { printInfo, printLines, printSuccess } from '../output';

export async function runReset(args: string[]): Promise<number> {
  const positionals = args.filter((a) => !a.startsWith('-'));
  const hard = args.includes('--hard');
  const repo = await resolveRepo(positionals[0], 'Usage: deltix reset [<repo>] [--hard]');
  if (!repo) return 1;
  const identity = await resolveServerIdentity(positionals[0] ?? repo);
  if (!identity) return 1;
  const local = await newLocalService();
  try {
    const { tables } = await local.resetWorkingSet(identity, { hard });
    if (hard) {
      printSuccess('Working tree reset to the current branch HEAD');
      if (tables.length > 0) {
        printLines(['Discarded uncommitted changes in tables:', ...tables.map((t) => `  ${t}`)]);
      } else {
        printInfo('Working tree was already clean (no tracked changes to discard).');
      }
    } else {
      printSuccess('Staged changes reset to HEAD (working values kept)');
      if (tables.length > 0) {
        printLines(['Unstaged tables:', ...tables.map((t) => `  ${t}`)]);
      }
    }
    return 0;
  } catch (err) {
    return handleVersioningError(err, 'Reset command failed');
  }
}

export async function runClean(args: string[]): Promise<number> {
  const positionals = args.filter((a) => !a.startsWith('-'));
  const dryRun = args.includes('--dry-run') || args.includes('-n');
  const repo = await resolveRepo(positionals[0], 'Usage: deltix clean [<repo>] [--dry-run|-n]');
  if (!repo) return 1;
  const identity = await resolveServerIdentity(positionals[0] ?? repo);
  if (!identity) return 1;
  const local = await newLocalService();
  try {
    const { tables, dryRun: wasDry } = await local.cleanWorkingSet(identity, { dryRun });
    if (tables.length === 0) {
      printInfo('No untracked tables to clean.');
      return 0;
    }
    if (wasDry) {
      printLines([
        'Untracked tables that would be deleted (dry run):',
        ...tables.map((t) => `  ${t}`),
      ]);
    } else {
      printSuccess('Deleted untracked tables from the working set');
      printLines(tables.map((t) => `  ${t}`));
    }
    return 0;
  } catch (err) {
    return handleVersioningError(err, 'Clean command failed');
  }
}
