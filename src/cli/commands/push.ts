import { newLocalService } from '../helpers';
import { handleSyncError } from '../helpers/handle-sync-error';
import { printError, printInfo, printSuccess } from '../output';
import { createVersioningService } from '../../contexts/versioning';
import { NoProjectError, CommitDataDirNotFoundError, LocalRepoInitError, InsufficientRoleError, RepoNotFoundError, ValidationError } from '../../contexts/local-project';

export async function runPush(args: string[]): Promise<number> {
  const [repoArg] = args;
  const identity = await resolveServerIdentity(repoArg);
  if (!identity) {
    return 1;
  }

  try {
    const localService = await newLocalService();

    const branch = 'main';
    const commits = await localService.getUnpushedCommits(identity, branch);
    const result = await createVersioningService().pushCommits(identity.repo, commits);

    const head = await localService.getBranchHead(identity, branch);
    if (head) {
      await localService.advanceRemoteRef(identity, branch, head);
    }

    printSuccess(`Pushed ${commits.length} commit(s) to ${identity.repo}`, {
      commitHash: result.commitHash,
      tables: commits.reduce((sum, c) => sum + c.tables.length, 0),
    });
    return 0;
  } catch (err) {
    return handleSyncError(err, 'Push');
  }
}
