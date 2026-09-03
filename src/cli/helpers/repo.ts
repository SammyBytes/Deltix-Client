import { createLocalProjectService, NoProjectError } from '../../contexts/local-project';
import { printError, printTable } from '../output';
import type { MergeConflictError } from '../../contexts/versioning/errors';

export function branchUsage(): number {
  printError('Usage: deltix branch <list|local|create|checkout|delete|current> [repo] [name]');
  return 1;
}

export function logMergeConflict(err: MergeConflictError): void {
  printError(`Merge failed with conflicts (source=${err.sourceBranch}, target=${err.targetBranch})`);
  printTable(err.conflicts.map((c) => ({ table: c.table, count: c.count })));
}

export async function resolveRepo(repoArg: string | undefined, usage: string): Promise<string | null> {
  if (repoArg) return repoArg;
  try {
    const project = await createLocalProjectService().resolve(process.cwd());
    return project.config.repo;
  } catch (err) {
    if (err instanceof NoProjectError) {
      printError(usage);
      return null;
    }
    throw err;
  }
}

export async function resolveRepoAndName(
  repoArg: string | undefined,
  nameArg: string | undefined,
  usage: string,
): Promise<{ repo: string; name: string } | null> {
  const repo = await resolveRepo(repoArg, usage);
  if (!repo) return null;
  if (!nameArg) {
    printError(usage);
    return null;
  }
  return { repo, name: nameArg };
}

export async function resolveServerIdentity(
  repoArg: string | undefined,
): Promise<{ repo: string; projectRoot?: string } | null> {
  const tryResolveProjectRoot = async (): Promise<{ repo: string; projectRoot?: string } | null> => {
    try {
      const project = await createLocalProjectService().resolve(process.cwd());
      return { repo: project.config.repo, projectRoot: project.root };
    } catch (err) {
      if (err instanceof NoProjectError) return null;
      throw err;
    }
  };

  if (repoArg) {
    const fromProject = await tryResolveProjectRoot();
    if (fromProject && fromProject.repo === repoArg) {
      return { repo: repoArg, projectRoot: fromProject.projectRoot };
    }
    return { repo: repoArg };
  }
  const fromProject = await tryResolveProjectRoot();
  if (!fromProject) return null;
  return fromProject;
}
