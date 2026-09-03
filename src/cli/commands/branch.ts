import { NoActiveSessionError, ServerUnreachableError } from '../../contexts/session';
import {
  createVersioningService,
  RepoNotFoundError,
  VersioningAuthenticationError,
} from '../../contexts/versioning';
import { handleVersioningError } from '../helpers/handle-versioning-error';
import { newLocalService } from '../helpers/newLocalService';
import {
  branchUsage,
  resolveRepo,
  resolveRepoAndName,
  resolveServerIdentity,
} from '../helpers/repo';
import { printInfo, printLines, printSuccess, printTable } from '../output';

export async function runBranch(args: string[]): Promise<number> {
  const [action, repoArg, nameArg] = args;
  if (!action) {
    return branchUsage();
  }

  // Helper: try server, fallback to local Dolt when repo not on server
  // (daily workflow is local-first: `deltix branch create` should work
  // even before `deltix push`).
  const tryLocalFallback = async (
    err: unknown,
    fn: () => Promise<number>,
  ): Promise<number | null> => {
    if (
      err instanceof RepoNotFoundError ||
      err instanceof ServerUnreachableError ||
      err instanceof VersioningAuthenticationError ||
      err instanceof NoActiveSessionError
    ) {
      try {
        return await fn();
      } catch (localErr) {
        return handleVersioningError(localErr, 'Branch command failed (local fallback)');
      }
    }
    return null;
  };

  try {
    const service = createVersioningService();
    switch (action) {
      case 'list': {
        const repo = await resolveRepo(repoArg, 'Usage: deltix branch list <repo>');
        if (!repo) return 1;
        try {
          const branches = await service.listBranches(repo);
          printTable(
            branches.map((branch) => ({
              branch: branch.name + (branch.isCurrent ? '  *' : ''),
            })),
          );
          return 0;
        } catch (err) {
          const fb = await tryLocalFallback(err, async () => {
            const identity = await resolveServerIdentity(repo);
            if (!identity) return 1;
            const local = await newLocalService();
            const { current, local: locals } = await local.listBranches(identity);
            printTable(locals.map((b) => ({ branch: b + (b === current ? '  *' : '') })));
            return 0;
          });
          if (fb !== null) return fb;
          throw err;
        }
      }
      case 'create': {
        const params = await resolveRepoAndName(
          repoArg,
          nameArg,
          'Usage: deltix branch create <repo> <name>',
        );
        if (!params) return 1;
        try {
          const branch = await service.createBranch(params.repo, params.name);
          printSuccess(`Branch created in ${params.repo}`, {
            current: branch.currentBranch,
            created: branch.createdBranch,
          });
          return 0;
        } catch (err) {
          const fb = await tryLocalFallback(err, async () => {
            const identity = await resolveServerIdentity(params.repo);
            if (!identity) return 1;
            const local = await newLocalService();
            await local.createBranch(identity, params.name);
            printSuccess(`Branch created locally in ${params.repo}`, { branch: params.name });
            return 0;
          });
          if (fb !== null) return fb;
          throw err;
        }
      }
      case 'checkout': {
        const params = await resolveRepoAndName(
          repoArg,
          nameArg,
          'Usage: deltix branch checkout <repo> <name>',
        );
        if (!params) return 1;
        try {
          const branch = await service.checkoutBranch(params.repo, params.name);
          printSuccess(`Checked out ${params.repo}`, {
            current: branch.currentBranch,
          });
          return 0;
        } catch (err) {
          const fb = await tryLocalFallback(err, async () => {
            const identity = await resolveServerIdentity(params.repo);
            if (!identity) return 1;
            const local = await newLocalService();
            await local.checkout(identity, params.name);
            printSuccess(`Checked out locally ${params.repo}`, { branch: params.name });
            return 0;
          });
          if (fb !== null) return fb;
          throw err;
        }
      }
      case 'delete': {
        const params = await resolveRepoAndName(
          repoArg,
          nameArg,
          'Usage: deltix branch delete <repo> <name>',
        );
        if (!params) return 1;
        try {
          await service.deleteBranch(params.repo, params.name);
          printSuccess(`Branch deleted in ${params.repo}`, { deleted: params.name });
          return 0;
        } catch (err) {
          const fb = await tryLocalFallback(err, async () => {
            const identity = await resolveServerIdentity(params.repo);
            if (!identity) return 1;
            const local = await newLocalService();
            await local.deleteBranch(identity, params.name);
            printSuccess(`Branch deleted locally in ${params.repo}`, { deleted: params.name });
            return 0;
          });
          if (fb !== null) return fb;
          throw err;
        }
      }
      case 'current': {
        const repo = await resolveRepo(repoArg, 'Usage: deltix branch current <repo>');
        if (!repo) return 1;
        try {
          const branch = await service.getCurrentBranch(repo);
          printInfo(`Current branch for ${repo}: ${branch}`);
          return 0;
        } catch (err) {
          const fb = await tryLocalFallback(err, async () => {
            const identity = await resolveServerIdentity(repo);
            if (!identity) return 1;
            const local = await newLocalService();
            const { current } = await local.listBranches(identity);
            printInfo(`Current branch for ${repo}: ${current ?? '(none)'}`);
            return 0;
          });
          if (fb !== null) return fb;
          throw err;
        }
      }
      case 'local': {
        const identity = await resolveServerIdentity(repoArg);
        if (!identity) return 1;
        const local = await newLocalService();
        const { current, local: locals, remote } = await local.listBranches(identity);
        printLines([
          'Local branches:',
          ...locals.map((b) => `  ${b === current ? '*' : ' '} ${b}`),
          '',
          'Remote-tracking branches:',
          ...(remote.length > 0
            ? remote.map((b) => `    ${b}`)
            : ['    (none — run deltix pull or fetch)']),
        ]);
        return 0;
      }
      default:
        return branchUsage();
    }
  } catch (err) {
    return handleVersioningError(err, 'Branch command failed');
  }
}
