/**
 * Local-first, git-style branch checkout shared by `deltix checkout` and
 * `deltix branch checkout`.
 *
 * Sequence (mirrors `git checkout` DWIM):
 *
 * 1. Branch exists locally           → switch to it.
 * 2. `origin/<branch>` is materialized (a previous push/pull/fetch, or a
 *    DWIM-from-server step)           → the local service creates the branch
 *                                    at that ref and switches (fixes "remote
 *                                    branch without local branch", issue #57).
 * 3. Branch exists on the server only → pull its full history, materialize
 *                                    it onto `origin/<branch>` (like `git
 *                                    fetch`), then DWIM-check it out — so the
 *                                    client needs no manual recovery step.
 * 4. Branch exists nowhere            → legacy behavior: create it at the
 *                                    current head (a brand-new local branch).
 *
 * If the repo has no local data dir at all (never cloned), this delegates to
 * a server-side checkout so the command still succeeds.
 */
import { createVersioningService, type VersioningService } from '../../contexts/versioning';
import {
  CommitDataDirNotFoundError,
  type LocalBranchList,
  type VersioningLocalService,
} from '../../contexts/versioning-local';
import { REMOTE_TRACKING_PREFIX } from '../../shared/constants';
import { withSpinner } from '../spinner';
import type { ServerIdentity } from './repo';

export type CheckoutSource = 'local' | 'origin' | 'server' | 'created';

/**
 * Checks out `branch` following the local-first DWIM sequence above.
 *
 * @throws CommitDataDirNotFoundError when the local repo has no data dir and
 *   no fallback repo dir exists — the caller may then fall back to a
 *   server-only checkout.
 */
export async function checkoutBranchLocalFirst(
  identity: ServerIdentity,
  branch: string,
  local: VersioningLocalService,
  service: VersioningService = createVersioningService(),
): Promise<CheckoutSource> {
  let lists: LocalBranchList;
  try {
    lists = await local.listBranches(identity);
  } catch (err) {
    if (err instanceof CommitDataDirNotFoundError) {
      // No local repo for this identity (repo has never been cloned here):
      // the best we can do is switch the active branch server-side.
      await service.checkoutBranch(identity.repo, branch);
      return 'server';
    }
    throw err;
  }

  if (lists.local.includes(branch)) {
    await local.checkout(identity, branch);
    return 'local';
  }

  const originRef = `${REMOTE_TRACKING_PREFIX}${branch}`;
  if (lists.remote.includes(originRef)) {
    // DWIM: the local service creates the branch at origin/<branch>.
    await local.checkout(identity, branch);
    return 'origin';
  }

  // Only reachable discovery: the branch may live on the server. A failure
  // here (offline, not authenticated) degrades to the legacy create-at-head
  // below — the origin/<branch> DWIM above already covered materialized refs.
  try {
    const serverBranches = await service.listBranches(identity.repo);
    if (serverBranches.some((b) => b.name === branch)) {
      const { commits, serverHead } = await withSpinner(
        `Fetching ${branch} from ${identity.repo}`,
        () => service.pullCommits(identity.repo, branch, null),
      );
      if (commits.length > 0) {
        await withSpinner('Applying fetched commits', () =>
          local.applyCommits(identity, originRef, commits),
        );
      }
      if (serverHead) {
        await local.saveSyncState(identity, branch, serverHead);
      }
      // DWIM: the local branch is created from the origin ref just materialized.
      await local.checkout(identity, branch);
      return 'server';
    }
  } catch {
    // Fall through to the legacy behavior below.
  }

  await local.checkout(identity, branch);
  return 'created';
}
