import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createLocalProjectService } from '../../contexts/local-project';
import { createVersioningService } from '../../contexts/versioning';
import { DEFAULT_BRANCH } from '../../shared/constants';
import { handleSyncError } from '../helpers/handle-sync-error';
import { newLocalService } from '../helpers/newLocalService';
import { resolveServerIdentity } from '../helpers/repo';
import { printError, printInfo, printSuccess } from '../output';

export async function runPull(args: string[]): Promise<number> {
  const abort = args.includes('--abort');
  const positional = args.filter((a) => !a.startsWith('--'));
  const repoArg = positional[0];

  const identity = await resolveServerIdentity(repoArg);
  if (!identity) {
    return 1;
  }
  const branch = DEFAULT_BRANCH;
  try {
    const local = await newLocalService();

    if (abort) {
      await local.mergeAbort(identity, branch);
      printSuccess(`Merge aborted for ${identity.repo}`);
      return 0;
    }

    const from = await local.getRemoteHead(identity, branch);
    const localHead = await local.getBranchHead(identity, branch);
    const diverged = Boolean(from && localHead && localHead !== from);

    const { commits, serverHead } = await createVersioningService().pullCommits(
      identity.repo,
      branch,
      from,
    );

    if (diverged) {
      // Materialize the server's new commits onto origin/<branch>, then merge
      // that into the local branch (git pull == fetch + merge).
      if (commits.length > 0) {
        await local.applyCommits(identity, `origin/${branch}`, commits);
      }
      const result = await local.mergeFromRemote(identity, branch);
      if (result.status === 'conflicts') {
        printError(
          `Merge conflicts in ${identity.repo}: ${result.conflicts
            .map((c) => `${c.table} (${c.numConflicts})`)
            .join(', ')}.`,
        );
        printInfo('Resolve them in the local Dolt repo, or run `deltix pull --abort`.');
        return 1;
      }
      const merged = await local.getBranchHead(identity, branch);
      if (merged) {
        await local.advanceRemoteRef(identity, branch, merged);
      }
      printSuccess(`Merged ${serverHead ? 'server changes' : 'origin'} into ${identity.repo}`, {
        head: merged,
      });
      return 0;
    }

    if (commits.length === 0) {
      if (serverHead) {
        await local.advanceRemoteRef(identity, branch, serverHead);
      }
      printInfo(`Already up to date for ${identity.repo}`);
      return 0;
    }
    const head = await local.applyCommits(identity, branch, commits);
    await local.advanceRemoteRef(identity, branch, head);
    printSuccess(`Pulled ${commits.length} commit(s) into ${identity.repo}`, { head });
    return 0;
  } catch (err) {
    return handleSyncError(err, 'Pull failed');
  }
}

export async function runFetch(args: string[]): Promise<number> {
  const [repoArg] = args;
  const identity = await resolveServerIdentity(repoArg);
  if (!identity) {
    return 1;
  }
  const branch = DEFAULT_BRANCH;
  try {
    const local = await newLocalService();
    const from = await local.getRemoteHead(identity, branch);
    if (!from) {
      printInfo(`No remote-tracking ref for ${identity.repo} yet — run \`deltix pull\` first.`);
      return 0;
    }
    const { commits, serverHead } = await createVersioningService().pullCommits(
      identity.repo,
      branch,
      from,
    );
    if (commits.length === 0) {
      if (serverHead && serverHead !== from) {
        await local.advanceRemoteRef(identity, branch, serverHead);
      }
      printInfo(`No new commits for ${identity.repo}`);
      return 0;
    }
    // Materialize onto origin/<branch>; leave the working branch untouched.
    await local.applyCommits(identity, `origin/${branch}`, commits);
    await local.checkout(identity, branch);
    printSuccess(`Fetched ${commits.length} commit(s) into origin/${branch} of ${identity.repo}`);
    return 0;
  } catch (err) {
    return handleSyncError(err, 'Fetch failed');
  }
}

export async function runClone(args: string[]): Promise<number> {
  const [repo] = args;
  if (!repo) {
    printError('Usage: deltix clone <repo>');
    return 1;
  }
  try {
    const targetDir = join(process.cwd(), repo);
    await mkdir(targetDir, { recursive: true });
    const project = await createLocalProjectService().init(targetDir, repo);
    const identity = { repo: project.config.repo, projectRoot: project.root };
    const local = await newLocalService();
    await local.initLocalRepo(identity);
    const { commits } = await createVersioningService().pullCommits(repo, DEFAULT_BRANCH, null);
    if (commits.length > 0) {
      const head = await local.applyCommits(identity, DEFAULT_BRANCH, commits);
      await local.advanceRemoteRef(identity, DEFAULT_BRANCH, head);
    }
    printSuccess(`Cloned ${repo} into ${targetDir}`, { commits: commits.length });
    printInfo(`Next: cd ${repo} && deltix start`);
    return 0;
  } catch (err) {
    return handleSyncError(err, 'Clone failed');
  }
}
