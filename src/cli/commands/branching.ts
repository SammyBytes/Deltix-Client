import { NoActiveSessionError, ServerUnreachableError } from '../../contexts/session';
import {
  createVersioningService,
  MergeConflictError,
  RepoNotFoundError,
  VersioningAuthenticationError,
} from '../../contexts/versioning';
import { handleSyncError } from '../helpers/handle-sync-error';
import { handleVersioningError } from '../helpers/handle-versioning-error';
import { newLocalService } from '../helpers/newLocalService';
import { logMergeConflict, resolveRepo, resolveServerIdentity } from '../helpers/repo';
import { printError, printSuccess } from '../output';

export async function runMerge(args: string[]): Promise<number> {
  const [repoArg, sourceBranch, targetBranch] = args;
  const repo = await resolveRepo(
    repoArg,
    'Usage: deltix merge <repo> <sourceBranch> [targetBranch]',
  );
  if (!repo || !sourceBranch) return 1;

  try {
    const merge = await createVersioningService().merge(repo, sourceBranch, targetBranch);
    printSuccess(`Merge completed for ${repo}${merge.fastForward ? ' (fast-forward)' : ''}`, {
      source: merge.sourceBranch,
      target: merge.targetBranch,
      commitHash: merge.commitHash,
      status: merge.status,
    });
    return 0;
  } catch (err) {
    if (err instanceof MergeConflictError) {
      logMergeConflict(err);
      return 1;
    }
    // Fallback to local Dolt merge when repo not on server (daily flow)
    if (
      err instanceof RepoNotFoundError ||
      err instanceof ServerUnreachableError ||
      err instanceof VersioningAuthenticationError ||
      err instanceof NoActiveSessionError
    ) {
      try {
        const identity = await resolveServerIdentity(repo);
        if (!identity) throw err;
        const local = await newLocalService();
        const result = await local.mergeBranches(identity, sourceBranch, targetBranch);
        if (result.conflicts > 0) {
          printError(`Merge failed with conflicts: ${result.conflicts} table(s)`);
          return 1;
        }
        printSuccess(
          `Merge completed locally for ${repo}${result.fastForward ? ' (fast-forward)' : ''}`,
          {
            source: sourceBranch,
            target: targetBranch ?? '(current)',
          },
        );
        return 0;
      } catch (localErr) {
        return handleVersioningError(localErr, 'Merge failed (local fallback)');
      }
    }
    return handleVersioningError(err, 'Merge failed');
  }
}

export async function runCheckout(args: string[]): Promise<number> {
  const [branch, repoArg] = args;
  // Support both `deltix checkout <branch>` and `deltix checkout <branch> <repo>`
  const b = branch;
  const r = repoArg;
  if (!b) {
    printError('Usage: deltix checkout <branch> [<repo>]');
    return 1;
  }
  // If second arg looks like a repo (we have it), use it; else resolve from cwd
  const repo = r ? await resolveRepo(r, 'Usage: deltix checkout <branch> [<repo>]') : null;
  const identity = repo
    ? await resolveServerIdentity(repo)
    : await resolveServerIdentity(undefined);
  if (!identity) {
    printError('Usage: deltix checkout <branch> [<repo>]  (or run from a deltix init project)');
    return 1;
  }
  try {
    const local = await newLocalService();
    await local.checkout(identity, b);
    printSuccess(`Checked out ${b} in ${identity.repo}`);
    return 0;
  } catch (err) {
    return handleSyncError(err, 'Checkout failed');
  }
}
