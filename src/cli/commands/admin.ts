import { createVersioningService } from '../../contexts/versioning';
import { handleVersioningError } from '../helpers/handle-versioning-error';
import { resolveRepo } from '../helpers/repo';
import { printError, printKeyValues, printSuccess, printTable } from '../output';

export async function runRepo(args: string[]): Promise<number> {
  const [action, repoArg] = args;
  if (!action) {
    printError('Usage: deltix repo <create|list|get> [repo]');
    return 1;
  }

  try {
    const service = createVersioningService();
    switch (action) {
      case 'create': {
        const repo = repoArg;
        if (!repo) {
          printError('Usage: deltix repo create <repo>');
          return 1;
        }
        const created = await service.createRepo(repo);
        printSuccess('Repo created', { repo: created });
        return 0;
      }
      case 'list': {
        const repos = await service.listRepos();
        printTable(
          repos.map((r) => ({
            repo: r.repoId,
            owner: r.createdBy,
            role: r.role ?? '-',
          })),
        );
        return 0;
      }
      case 'get': {
        const repo = await resolveRepo(repoArg, 'Usage: deltix repo get <repo>');
        if (!repo) return 1;
        const found = await service.getRepo(repo);
        printKeyValues({
          repo: found.repoId,
          owner: found.createdBy,
          role: found.role ?? '-',
          doltPath: found.doltPath,
          createdAt: new Date(found.createdAt).toISOString(),
        });
        return 0;
      }
      default:
        printError('Usage: deltix repo <create|list|get> [repo]');
        return 1;
    }
  } catch (err) {
    return handleVersioningError(err, 'Repo command failed');
  }
}

export async function runRoles(args: string[]): Promise<number> {
  const [action, repoArg, username, role] = args;
  if (!action) {
    printError('Usage: deltix roles <list|grant|revoke> [repo] [username] [role]');
    return 1;
  }

  try {
    const service = createVersioningService();
    switch (action) {
      case 'list': {
        const repo = await resolveRepo(repoArg, 'Usage: deltix roles list <repo>');
        if (!repo) return 1;
        const roles = await service.listRoles(repo);
        printTable(roles as unknown as Array<Record<string, unknown>>);
        return 0;
      }
      case 'grant': {
        const repo = await resolveRepo(
          repoArg,
          'Usage: deltix roles grant <repo> <username> <reader|writer|admin>',
        );
        if (!repo || !username || !role || !['reader', 'writer', 'admin'].includes(role)) {
          return 1;
        }
        const assignment = await service.grantRole(
          repo,
          username,
          role as 'reader' | 'writer' | 'admin',
        );
        printSuccess(`Role granted in ${repo}`, assignment as unknown as Record<string, unknown>);
        return 0;
      }
      case 'revoke': {
        const repo = await resolveRepo(repoArg, 'Usage: deltix roles revoke <repo> <username>');
        if (!repo || !username) return 1;
        await service.revokeRole(repo, username);
        printSuccess(`Role revoked in ${repo}`, { username });
        return 0;
      }
      default:
        printError('Usage: deltix roles <list|grant|revoke> <repo> [username] [role]');
        return 1;
    }
  } catch (err) {
    return handleVersioningError(err, 'Roles command failed');
  }
}
