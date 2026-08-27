#!/usr/bin/env bun
/**
 * Deltix-Client CLI entrypoint.
 *
 * Presentation only: parses argv and delegates to the relevant bounded
 * context's public API. No business logic lives here (see
 * .github/copilot-instructions.md §2).
 *
 * Command results are printed via `./output.ts` (human-readable), never via
 * the structured Pino logger — the logger is for diagnostics, not for
 * interactive command output (see output.ts doc comment for context).
 */
import {
  createDataflowService,
  LocalFileNotFoundError,
  TicketAuthenticationError,
  TransferAbortedError,
} from '../contexts/dataflow';
import {
  createSessionService,
  InvalidCredentialsError,
  NoActiveSessionError,
} from '../contexts/session';
import {
  BranchAlreadyExistsError,
  BranchNotFoundError,
  createVersioningService,
  InsufficientRoleError,
  MergeConflictError,
  ProtectedBranchError,
  RepoAlreadyExistsError,
  RepoNotFoundError,
  RoleAssignmentNotFoundError,
  UserNotFoundError,
  ValidationError,
  VersioningAuthenticationError,
} from '../contexts/versioning';
import {
  printError,
  printInfo,
  printKeyValues,
  printLines,
  printSuccess,
  printTable,
} from './output';

async function runLogin(args: string[]): Promise<number> {
  const [username, password] = args;
  if (!username || !password) {
    printError('Usage: deltix login <username> <password>');
    return 1;
  }

  try {
    await createSessionService().login(username, password);
    printSuccess(`Logged in as ${username}`);
    return 0;
  } catch (err) {
    if (err instanceof InvalidCredentialsError) {
      printError('Login failed: invalid credentials');
      return 1;
    }
    printError(`Login failed: ${String(err)}`);
    return 1;
  }
}

async function runLogout(): Promise<number> {
  try {
    await createSessionService().logout();
    printSuccess('Logged out');
    return 0;
  } catch (err) {
    if (err instanceof NoActiveSessionError) {
      printError('Not logged in');
      return 1;
    }
    printError(`Logout failed: ${String(err)}`);
    return 1;
  }
}

async function runWhoami(): Promise<number> {
  const status = await createSessionService().status();
  if (status.loggedIn) {
    printInfo(`Logged in as ${status.username}`);
  } else {
    printInfo('Not logged in');
  }
  return 0;
}

async function runPush(args: string[]): Promise<number> {
  const [repo, localFilePath] = args;
  if (!repo || !localFilePath) {
    printError('Usage: deltix push <repo> <local-file-path>');
    return 1;
  }

  try {
    const result = await createDataflowService().push(repo, localFilePath);
    printSuccess(`Push completed for ${repo}`, {
      jobId: result.jobId,
      checksum: result.checksum,
      bytesSent: result.bytesSent,
    });
    return 0;
  } catch (err) {
    return handleDataflowError(err, 'Push failed');
  }
}

async function runPull(args: string[]): Promise<number> {
  const [repo, destinationFilePath] = args;
  if (!repo || !destinationFilePath) {
    printError('Usage: deltix pull <repo> <destination-file-path>');
    return 1;
  }

  try {
    const result = await createDataflowService().pull(repo, destinationFilePath);
    printSuccess(`Pull completed for ${repo}`, {
      bytesReceived: result.bytesReceived,
      checksum: result.checksum,
    });
    return 0;
  } catch (err) {
    return handleDataflowError(err, 'Pull failed');
  }
}

function parseFlagValue(args: string[], flagName: string): string | undefined {
  return args.find((arg) => arg.startsWith(`--${flagName}=`))?.slice(flagName.length + 3);
}

function normalizeTables(args: string[]): string[] | null {
  return args.length > 0 ? args : null;
}

function branchUsage(): number {
  printError('Usage: deltix branch <list|create|checkout|delete|current> <repo> [name]');
  return 1;
}

function logMergeConflict(err: MergeConflictError): void {
  printError(
    `Merge failed with conflicts (source=${err.sourceBranch}, target=${err.targetBranch})`,
  );
  printTable(err.conflicts.map((conflict) => ({ table: conflict.table, count: conflict.count })));
}

function requireRepo(repo: string | undefined, usage: string): string | null {
  if (!repo) {
    printError(usage);
    return null;
  }
  return repo;
}

function requireRepoAndName(
  repo: string | undefined,
  name: string | undefined,
  usage: string,
): { repo: string; name: string } | null {
  if (!repo || !name) {
    printError(usage);
    return null;
  }
  return { repo, name };
}

async function runBranch(args: string[]): Promise<number> {
  const [action, repoArg, nameArg] = args;
  if (!action) {
    return branchUsage();
  }

  try {
    const service = createVersioningService();
    switch (action) {
      case 'list': {
        const repo = requireRepo(repoArg, 'Usage: deltix branch list <repo>');
        if (!repo) return 1;
        const branches = await service.listBranches(repo);
        printTable(branches.map((branch) => ({ branch })));
        return 0;
      }
      case 'create': {
        const params = requireRepoAndName(
          repoArg,
          nameArg,
          'Usage: deltix branch create <repo> <name>',
        );
        if (!params) return 1;
        const branch = await service.createBranch(params.repo, params.name);
        printSuccess(`Branch created in ${params.repo}`, { branch });
        return 0;
      }
      case 'checkout': {
        const params = requireRepoAndName(
          repoArg,
          nameArg,
          'Usage: deltix branch checkout <repo> <name>',
        );
        if (!params) return 1;
        const branch = await service.checkoutBranch(params.repo, params.name);
        printSuccess(`Checked out ${params.repo}`, { branch });
        return 0;
      }
      case 'delete': {
        const params = requireRepoAndName(
          repoArg,
          nameArg,
          'Usage: deltix branch delete <repo> <name>',
        );
        if (!params) return 1;
        await service.deleteBranch(params.repo, params.name);
        printSuccess(`Branch deleted in ${params.repo}`, { branch: params.name });
        return 0;
      }
      case 'current': {
        const repo = requireRepo(repoArg, 'Usage: deltix branch current <repo>');
        if (!repo) return 1;
        const branch = await service.getCurrentBranch(repo);
        printInfo(`Current branch for ${repo}: ${branch}`);
        return 0;
      }
      default:
        return branchUsage();
    }
  } catch (err) {
    return handleVersioningError(err, 'Branch command failed');
  }
}

async function runRepo(args: string[]): Promise<number> {
  const [action, repoArg] = args;
  if (!action) {
    printError('Usage: deltix repo <create|list|get> [repo]');
    return 1;
  }

  try {
    const service = createVersioningService();
    switch (action) {
      case 'create': {
        const repo = requireRepo(repoArg, 'Usage: deltix repo create <repo>');
        if (!repo) return 1;
        const created = await service.createRepo(repo);
        printSuccess('Repo created', { repo: created });
        return 0;
      }
      case 'list': {
        const repos = await service.listRepos();
        printTable(repos.map((repo) => ({ repo })));
        return 0;
      }
      case 'get': {
        const repo = requireRepo(repoArg, 'Usage: deltix repo get <repo>');
        if (!repo) return 1;
        const found = await service.getRepo(repo);
        printKeyValues({ repo: found });
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

async function runMerge(args: string[]): Promise<number> {
  const [repo, sourceBranch, targetBranch] = args;
  if (!repo || !sourceBranch) {
    printError('Usage: deltix merge <repo> <sourceBranch> [targetBranch]');
    return 1;
  }

  try {
    const merge = await createVersioningService().merge(repo, sourceBranch, targetBranch);
    printSuccess(`Merge completed for ${repo}`, { merge });
    return 0;
  } catch (err) {
    if (err instanceof MergeConflictError) {
      logMergeConflict(err);
      return 1;
    }
    return handleVersioningError(err, 'Merge failed');
  }
}

async function runLog(args: string[]): Promise<number> {
  const [repo, ...flags] = args;
  if (!repo) {
    printError('Usage: deltix log <repo> [--branch=name] [--limit=N]');
    return 1;
  }

  const branch = parseFlagValue(flags, 'branch');
  const limitValue = parseFlagValue(flags, 'limit');
  const limit = limitValue ? Number(limitValue) : undefined;

  try {
    const log = await createVersioningService().getLog(repo, {
      ...(branch ? { branch } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    printTable(log as unknown as Array<Record<string, unknown>>);
    return 0;
  } catch (err) {
    return handleVersioningError(err, 'Log failed');
  }
}

async function runDiff(args: string[]): Promise<number> {
  const [repo, from, to] = args;
  if (!repo || !from || !to) {
    printError('Usage: deltix diff <repo> <from> <to>');
    return 1;
  }

  try {
    const diff = await createVersioningService().getDiff(repo, from, to);
    printKeyValues({ repo, from, to });
    printTable(diff as unknown as Array<Record<string, unknown>>);
    return 0;
  } catch (err) {
    return handleVersioningError(err, 'Diff failed');
  }
}

async function runRoles(args: string[]): Promise<number> {
  const [action, repo, username, role] = args;
  if (!action) {
    printError('Usage: deltix roles <list|grant|revoke> <repo> [username] [role]');
    return 1;
  }

  try {
    const service = createVersioningService();
    switch (action) {
      case 'list': {
        if (!repo) {
          printError('Usage: deltix roles list <repo>');
          return 1;
        }
        const roles = await service.listRoles(repo);
        printTable(roles as unknown as Array<Record<string, unknown>>);
        return 0;
      }
      case 'grant': {
        if (!repo || !username || !role || !['reader', 'writer', 'admin'].includes(role)) {
          printError('Usage: deltix roles grant <repo> <username> <reader|writer|admin>');
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
        if (!repo || !username) {
          printError('Usage: deltix roles revoke <repo> <username>');
          return 1;
        }
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

async function runSyncPrefsGet(
  service: ReturnType<typeof createVersioningService>,
  repo: string | undefined,
): Promise<number> {
  if (!repo) {
    printError('Usage: deltix sync-prefs get <repo>');
    return 1;
  }
  const preference = await service.getSyncPreferences(repo);
  printKeyValues((preference ?? {}) as Record<string, unknown>);
  return 0;
}

async function runSyncPrefsSet(
  service: ReturnType<typeof createVersioningService>,
  repo: string | undefined,
  mode: string | undefined,
  tables: string[],
): Promise<number> {
  if (!repo || !mode || !['schema-only', 'schema-and-data'].includes(mode)) {
    printError('Usage: deltix sync-prefs set <repo> <schema-only|schema-and-data> [tables...]');
    return 1;
  }
  const preference = await service.setSyncPreferences(
    repo,
    mode === 'schema-only' ? 'schema_only' : 'schema_and_data',
    normalizeTables(tables),
  );
  printSuccess(
    `Sync preferences updated for ${repo}`,
    preference as unknown as Record<string, unknown>,
  );
  return 0;
}

async function runSyncPrefsDryRun(
  service: ReturnType<typeof createVersioningService>,
  repo: string | undefined,
  mode: string | undefined,
  tables: string[],
): Promise<number> {
  if (!repo) {
    printError('Usage: deltix sync-prefs dry-run <repo> [tables...]');
    return 1;
  }
  const requestedTables = mode ? [mode, ...tables] : tables;
  // Honor the previously saved sync-preference mode instead of silently
  // forcing schema_and_data — a stored schema_only preference must not be
  // overridden by a dry-run preview.
  const stored = await service.getSyncPreferences(repo);
  const dryRunMode = stored?.mode ?? 'schema_and_data';
  const plan = await service.dryRunSyncPreferences(
    repo,
    dryRunMode,
    normalizeTables(requestedTables),
  );
  printKeyValues(plan as unknown as Record<string, unknown>);
  return 0;
}

async function runSyncPrefs(args: string[]): Promise<number> {
  const [action, repo, mode, ...tables] = args;
  if (!action) {
    printError('Usage: deltix sync-prefs <get|set|dry-run> <repo> [mode] [tables...]');
    return 1;
  }

  try {
    const service = createVersioningService();
    switch (action) {
      case 'get':
        return runSyncPrefsGet(service, repo);
      case 'set':
        return runSyncPrefsSet(service, repo, mode, tables);
      case 'dry-run':
        return runSyncPrefsDryRun(service, repo, mode, tables);
      default:
        printError('Usage: deltix sync-prefs <get|set|dry-run> <repo> [mode] [tables...]');
        return 1;
    }
  } catch (err) {
    return handleVersioningError(err, 'Sync preferences command failed');
  }
}

function handleVersioningError(err: unknown, action: string): number {
  if (err instanceof NoActiveSessionError || err instanceof VersioningAuthenticationError) {
    printError('Not logged in. Run `deltix login` first.');
    return 1;
  }
  if (
    err instanceof InsufficientRoleError ||
    err instanceof RepoNotFoundError ||
    err instanceof BranchNotFoundError ||
    err instanceof BranchAlreadyExistsError ||
    err instanceof ProtectedBranchError ||
    err instanceof RepoAlreadyExistsError ||
    err instanceof RoleAssignmentNotFoundError ||
    err instanceof UserNotFoundError ||
    err instanceof ValidationError
  ) {
    printError(`${action}: ${err.message}`);
    return 1;
  }
  printError(`${action}: ${String(err)}`);
  return 1;
}

function handleDataflowError(err: unknown, action: string): number {
  if (err instanceof NoActiveSessionError || err instanceof TicketAuthenticationError) {
    printError('Not logged in. Run `deltix login` first.');
    return 1;
  }
  if (err instanceof LocalFileNotFoundError) {
    printError(`${action}: ${err.message}`);
    return 1;
  }
  if (err instanceof TransferAbortedError) {
    printError(`${action}: ${err.message}`);
    return 1;
  }
  printError(`${action}: ${String(err)}`);
  return 1;
}

export async function runCli(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  switch (command) {
    case 'login':
      return runLogin(rest);
    case 'logout':
      return runLogout();
    case 'whoami':
      return runWhoami();
    case 'push':
      return runPush(rest);
    case 'pull':
      return runPull(rest);
    case 'repo':
      return runRepo(rest);
    case 'branch':
      return runBranch(rest);
    case 'merge':
      return runMerge(rest);
    case 'log':
      return runLog(rest);
    case 'diff':
      return runDiff(rest);
    case 'roles':
      return runRoles(rest);
    case 'sync-prefs':
      return runSyncPrefs(rest);
    default:
      printLines([
        'Deltix-Client versioning parity with Deltix-Server Fase 5',
        'Usage: deltix <login|logout|whoami|push|pull|repo|branch|merge|log|diff|roles|sync-prefs> [...args]',
        '  deltix repo create <repo>',
        '  deltix repo list',
        '  deltix repo get <repo>',
        '  deltix branch list <repo>',
        '  deltix branch create <repo> <name>',
        '  deltix branch checkout <repo> <name>',
        '  deltix branch delete <repo> <name>',
        '  deltix branch current <repo>',
        '  deltix merge <repo> <sourceBranch> [targetBranch]',
        '  deltix log <repo> [--branch=name] [--limit=N]',
        '  deltix diff <repo> <from> <to>',
        '  deltix roles list <repo>',
        '  deltix roles grant <repo> <username> <reader|writer|admin>',
        '  deltix roles revoke <repo> <username>',
        '  deltix sync-prefs get <repo>',
        '  deltix sync-prefs set <repo> <schema-only|schema-and-data> [tables...]',
        '  deltix sync-prefs dry-run <repo> [tables...]',
      ]);
      return command ? 1 : 0;
  }
}

if (import.meta.main) {
  const exitCode = await runCli(process.argv.slice(2));
  process.exit(exitCode);
}
