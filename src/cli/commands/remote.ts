import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createLocalProjectService } from '../../contexts/local-project';
import { createVersioningService } from '../../contexts/versioning';
import { DEFAULT_BRANCH } from '../../shared/constants';
import { handleSyncError } from '../helpers/handle-sync-error';
import { newLocalService } from '../helpers/newLocalService';
import { resolveServerIdentity } from '../helpers/repo';
import { printError, printInfo, printSuccess } from '../output';
import { withSpinner } from '../spinner';

export async function runPull(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    printInfo('Usage: deltix pull [repo] [--abort]');
    return 0;
  }
  const abort = args.includes('--abort');
  const positional = args.filter((a) => !a.startsWith('--'));
  const repoArg = positional[0];

  const identity = await resolveServerIdentity(repoArg);
  if (!identity) {
    return 1;
  }
  const branch = identity.branch;
  try {
    const local = await newLocalService();

    if (abort) {
      await withSpinner('Aborting merge', () => local.mergeAbort(identity, branch));
      printSuccess(`Merge aborted for ${identity.repo}`);
      return 0;
    }

    const from = await local.getRemoteHead(identity, branch);
    const localHead = await local.getBranchHead(identity, branch);
    const diverged = Boolean(from && localHead && localHead !== from);

    const { commits, serverHead } = await withSpinner(
      `Fetching changes from ${identity.repo}`,
      () => createVersioningService().pullCommits(identity.repo, branch, from),
    );

    if (diverged) {
      // Materialize the server's new commits onto origin/<branch>, then merge
      // that into the local branch (git pull == fetch + merge).
      if (commits.length > 0) {
        await withSpinner('Applying server commits', () =>
          local.applyCommits(identity, `origin/${branch}`, commits),
        );
      }
      const result = await withSpinner('Merging into local branch', () =>
        local.mergeFromRemote(identity, branch),
      );
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
        await withSpinner('Advancing remote ref', () =>
          local.advanceRemoteRef(identity, branch, merged),
        );
      }
      if (serverHead) {
        await local.saveSyncState(identity, branch, serverHead);
      }
      printSuccess(`Merged ${serverHead ? 'server changes' : 'origin'} into ${identity.repo}`, {
        head: merged,
      });
      return 0;
    }

    if (commits.length === 0) {
      if (serverHead) {
        await withSpinner('Advancing remote ref', () =>
          local.advanceRemoteRef(identity, branch, serverHead),
        );
        await local.saveSyncState(identity, branch, serverHead);
      }
      printInfo(`Already up to date for ${identity.repo}`);
      return 0;
    }
    const head = await withSpinner('Applying pulled commits', () =>
      local.applyCommits(identity, branch, commits),
    );
    await withSpinner('Advancing remote ref', () => local.advanceRemoteRef(identity, branch, head));
    if (serverHead) {
      await local.saveSyncState(identity, branch, serverHead);
    }
    printSuccess(`Pulled ${commits.length} commit(s) into ${identity.repo}`, { head });
    return 0;
  } catch (err) {
    return handleSyncError(err, 'Pull failed');
  }
}

export async function runFetch(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    printInfo('Usage: deltix fetch [repo]');
    return 0;
  }
  const [repoArg] = args;
  const identity = await resolveServerIdentity(repoArg);
  if (!identity) {
    return 1;
  }
  const branch = identity.branch;
  try {
    const local = await newLocalService();
    const from = await local.getRemoteHead(identity, branch);
    if (!from) {
      printInfo(`No remote-tracking ref for ${identity.repo} yet — run \`deltix pull\` first.`);
      return 0;
    }
    const { commits, serverHead } = await withSpinner(
      `Fetching changes from ${identity.repo}`,
      () => createVersioningService().pullCommits(identity.repo, branch, from),
    );
    if (commits.length === 0) {
      if (serverHead && serverHead !== from) {
        await withSpinner('Advancing remote ref', () =>
          local.advanceRemoteRef(identity, branch, serverHead),
        );
        await local.saveSyncState(identity, branch, serverHead);
      }
      printInfo(`No new commits for ${identity.repo}`);
      return 0;
    }
    // Materialize onto origin/<branch>; leave the working branch untouched.
    await withSpinner('Applying fetched commits', () =>
      local.applyCommits(identity, `origin/${branch}`, commits),
    );
    if (serverHead) {
      await local.saveSyncState(identity, branch, serverHead);
    }
    await withSpinner('Checking out branch', () => local.checkout(identity, branch));
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
    await withSpinner('Initializing local repo', () => local.initLocalRepo(identity));
    const { commits, serverHead } = await withSpinner(`Downloading repo ${repo}`, () =>
      createVersioningService().pullCommits(repo, DEFAULT_BRANCH, null),
    );
    if (commits.length > 0) {
      const head = await withSpinner('Checking out data', () =>
        local.applyCommits(identity, DEFAULT_BRANCH, commits),
      );
      await withSpinner('Advancing remote ref', () =>
        local.advanceRemoteRef(identity, DEFAULT_BRANCH, head),
      );
    }
    if (serverHead) {
      await local.saveSyncState(identity, DEFAULT_BRANCH, serverHead);
    }
    printSuccess(`Cloned ${repo} into ${targetDir}`, { commits: commits.length });
    printInfo(`Next: cd ${repo} && deltix start`);
    return 0;
  } catch (err) {
    return handleSyncError(err, 'Clone failed');
  }
}
