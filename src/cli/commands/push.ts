import { createVersioningService } from '../../contexts/versioning';
import { newLocalService } from '../helpers';
import { handleSyncError } from '../helpers/handle-sync-error';
import { resolveServerIdentity } from '../helpers/repo';
import { printInfo, printSuccess } from '../output';
import { withSpinner } from '../spinner';
import { reconcileBranch } from './remote';

export async function runPush(args: string[]): Promise<number> {
  const [repoArg] = args;
  const identity = await resolveServerIdentity(repoArg);
  if (!identity) {
    return 1;
  }

  try {
    const localService = await newLocalService();

    const branch = await reconcileBranch(identity, localService);
    const commits = await withSpinner('Reading unpushed commits', () =>
      localService.getUnpushedCommits(identity, branch),
    );

    if (commits.length === 0) {
      printInfo('Nothing to push — working tree is already up to date.');
      return 0;
    }

    const from = await localService.getRemoteHead(identity, branch);

    const result = await withSpinner(
      `Pushing ${commits.length} commit(s) to ${identity.repo}`,
      () => createVersioningService().pushCommits(identity.repo, commits, from, branch),
    );

    await withSpinner('Advancing remote ref', async () => {
      const head = await localService.getBranchHead(identity, branch);
      if (head) {
        await localService.advanceRemoteRef(identity, branch, head);
      }
    });

    printSuccess(`Pushed ${commits.length} commit(s) to ${identity.repo}`, {
      commitHash: result.commitHash,
      tables: commits.reduce((sum, c) => sum + c.tables.length, 0),
    });
    return 0;
  } catch (err) {
    return handleSyncError(err, 'Push');
  }
}
