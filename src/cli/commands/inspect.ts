import { createLocalProjectService, NoProjectError } from '../../contexts/local-project';
import { createVersioningService } from '../../contexts/versioning';
import { flagValue, parseFlagValue, splitPositionalsAndFlags } from '../helpers/args';
import { handleSyncError } from '../helpers/handle-sync-error';
import { handleVersioningError } from '../helpers/handle-versioning-error';
import { newLocalService } from '../helpers/newLocalService';
import { resolveRepo, resolveServerIdentity } from '../helpers/repo';
import { printError, printInfo, printKeyValues, printTable } from '../output';

export async function runLog(args: string[]): Promise<number> {
  // Separate flags from positionals so `deltix log -n 5 hmc-sync` works
  // regardless of flag position (like git log -n 5 <branch>).
  const { positionals, flags } = splitPositionalsAndFlags(args);
  const repoArg = positionals[0];
  // Mirror `deltix push`: when no repo is given, fall back to the project
  // initialised in cwd so a developer doesn't have to remember the repo name
  // they typed at `deltix init` time. Without this, `deltix log` from inside a
  // working tree would print a usage error even though the project context is
  // unambiguous.
  let repo = repoArg;
  if (!repo) {
    try {
      const project = await createLocalProjectService().resolve(process.cwd());
      repo = project.config.repo;
    } catch (err) {
      if (err instanceof NoProjectError) {
        printError(
          'Usage: deltix log <repo> [--branch=name|-b name] [--limit=N|-n N]   (omit <repo> to use the cwd project)',
        );
        return 1;
      }
      throw err;
    }
  }

  // Accept both --branch=foo (long) and --branch foo or -b foo (shell-friendly).
  const branch = parseFlagValue(flags, 'branch') ?? flagValue(flags, 'b');
  const limitValue = parseFlagValue(flags, 'limit') ?? parseFlagValue(flags, 'n');
  const limit = limitValue ? Number(limitValue) : undefined;

  try {
    const log = await createVersioningService().getLog(repo, {
      ...(branch ? { branch } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    // Server returns `{ commits: [...], limit }`; printTable expects the row
    // array directly. The previous `log as unknown as Array<...>` cast hid the
    // shape mismatch and turned into a runtime `rows.reduce is not a function`
    // every time anyone ran `deltix log`.
    printTable(log.commits as unknown as Array<Record<string, unknown>>);
    return 0;
  } catch (err) {
    return handleVersioningError(err, 'Log failed');
  }
}

export async function runDiff(args: string[]): Promise<number> {
  const [repoArg, from, to] = args;

  // Local working-tree diff (Git-like): `deltix diff` / `deltix diff <repo> [table]`
  // shows what the app/ORM wrote to Dolt via the MySQL wire protocol.
  // Server diff (existing): `deltix diff <repo> <from> <to>`.
  if (!from || !to) {
    // 0 args: cwd project, 1 arg: repo, 2 args: repo + table
    let identity: { repo: string; projectRoot?: string } | null = null;
    let table: string | undefined;
    if (args.length === 0) {
      identity = await resolveServerIdentity(undefined);
    } else if (args.length === 1) {
      identity = await resolveServerIdentity(repoArg);
    } else if (args.length === 2) {
      identity = await resolveServerIdentity(repoArg);
      table = from;
    }
    if (!identity) {
      printError(
        'Usage: deltix diff [<repo> [<from> <to> | <table>]]  (no refs = working-tree diff)',
      );
      return 1;
    }
    try {
      const local = await newLocalService();
      const { raw } = await local.getWorkingDiffSummary(identity, table);
      if (!raw) {
        printInfo('No changes in working tree.');
        return 0;
      }
      printInfo(`Working-tree diff for ${identity.repo}${table ? ` / ${table}` : ''}:`);
      for (const line of raw.split('\n').filter(Boolean)) {
        printInfo(`  ${line}`);
      }
      printInfo('  (unstaged — `deltix status` for overview, `deltix commit -m "msg"` to stage)');
      return 0;
    } catch (err) {
      return handleSyncError(err, 'Diff failed');
    }
  }

  const repo = await resolveRepo(repoArg, 'Usage: deltix diff <repo> <from> <to>');
  if (!repo || !from || !to) return 1;

  try {
    const diff = await createVersioningService().getDiff(repo, from, to);
    // Server returns `{ fromRef, toRef, tables: [...] }`. The row table is
    // `diff.tables`, not `diff` itself — passing `diff` directly (and casting
    // away the type) was the source of the `rows.reduce is not a function` bug
    // when this command hit a real server response.
    printKeyValues({ repo, from, to });
    printTable(diff.tables as unknown as Array<Record<string, unknown>>);
    return 0;
  } catch (err) {
    return handleVersioningError(err, 'Diff failed');
  }
}
