#!/usr/bin/env bun
/**
 * Deltix-Client CLI entrypoint.
 *
 * Presentation only: parses argv and delegates to the relevant bounded
 * context's public API. No business logic lives here (see
 * .github/copilot-instructions.md §2).
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
import { createLogger } from '../shared/logger';

const logger = createLogger('cli');

async function runLogin(args: string[]): Promise<number> {
  const [username, password] = args;
  if (!username || !password) {
    logger.error('Usage: deltix login <username> <password>');
    return 1;
  }

  try {
    await createSessionService().login(username, password);
    logger.info({ username }, 'Login successful');
    return 0;
  } catch (err) {
    if (err instanceof InvalidCredentialsError) {
      logger.error('Login failed: invalid credentials');
      return 1;
    }
    logger.error({ err: String(err) }, 'Login failed');
    return 1;
  }
}

async function runLogout(): Promise<number> {
  try {
    await createSessionService().logout();
    logger.info('Logout successful');
    return 0;
  } catch (err) {
    if (err instanceof NoActiveSessionError) {
      logger.error('Not logged in');
      return 1;
    }
    logger.error({ err: String(err) }, 'Logout failed');
    return 1;
  }
}

async function runWhoami(): Promise<number> {
  const status = await createSessionService().status();
  if (status.loggedIn) {
    logger.info({ username: status.username }, 'Logged in');
  } else {
    logger.info('Not logged in');
  }
  return 0;
}

async function runPush(args: string[]): Promise<number> {
  const [repo, localFilePath] = args;
  if (!repo || !localFilePath) {
    logger.error('Usage: deltix push <repo> <local-file-path>');
    return 1;
  }

  try {
    const result = await createDataflowService().push(repo, localFilePath);
    logger.info(
      { repo, jobId: result.jobId, checksum: result.checksum, bytesSent: result.bytesSent },
      'Push completed',
    );
    return 0;
  } catch (err) {
    return handleDataflowError(err, 'Push failed');
  }
}

async function runPull(args: string[]): Promise<number> {
  const [repo, destinationFilePath] = args;
  if (!repo || !destinationFilePath) {
    logger.error('Usage: deltix pull <repo> <destination-file-path>');
    return 1;
  }

  try {
    const result = await createDataflowService().pull(repo, destinationFilePath);
    logger.info(
      { repo, bytesReceived: result.bytesReceived, checksum: result.checksum },
      'Pull completed',
    );
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
  logger.error('Usage: deltix branch <list|create|checkout|delete|current> <repo> [name]');
  return 1;
}

function logMergeConflict(err: MergeConflictError): void {
  logger.error(
    {
      sourceBranch: err.sourceBranch,
      targetBranch: err.targetBranch,
      conflicts: err.conflicts.map((conflict) => ({
        table: conflict.table,
        count: conflict.count,
      })),
    },
    'Merge failed with conflicts',
  );
}

function requireRepo(repo: string | undefined, usage: string): string | null {
  if (!repo) {
    logger.error(usage);
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
    logger.error(usage);
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
        logger.info({ repo, branches }, 'Branch list');
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
        logger.info({ repo: params.repo, branch }, 'Branch created');
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
        logger.info({ repo: params.repo, branch }, 'Branch checked out');
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
        logger.info({ repo: params.repo, branch: params.name }, 'Branch deleted');
        return 0;
      }
      case 'current': {
        const repo = requireRepo(repoArg, 'Usage: deltix branch current <repo>');
        if (!repo) return 1;
        const branch = await service.getCurrentBranch(repo);
        logger.info({ repo, branch }, 'Current branch');
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
    logger.error('Usage: deltix repo <create|list|get> [repo]');
    return 1;
  }

  try {
    const service = createVersioningService();
    switch (action) {
      case 'create': {
        const repo = requireRepo(repoArg, 'Usage: deltix repo create <repo>');
        if (!repo) return 1;
        const created = await service.createRepo(repo);
        logger.info({ repo: created }, 'Repo created');
        return 0;
      }
      case 'list': {
        const repos = await service.listRepos();
        logger.info({ repos }, 'Repo list');
        return 0;
      }
      case 'get': {
        const repo = requireRepo(repoArg, 'Usage: deltix repo get <repo>');
        if (!repo) return 1;
        const found = await service.getRepo(repo);
        logger.info({ repo: found }, 'Repo details');
        return 0;
      }
      default:
        logger.error('Usage: deltix repo <create|list|get> [repo]');
        return 1;
    }
  } catch (err) {
    return handleVersioningError(err, 'Repo command failed');
  }
}

async function runMerge(args: string[]): Promise<number> {
  const [repo, sourceBranch, targetBranch] = args;
  if (!repo || !sourceBranch) {
    logger.error('Usage: deltix merge <repo> <sourceBranch> [targetBranch]');
    return 1;
  }

  try {
    const merge = await createVersioningService().merge(repo, sourceBranch, targetBranch);
    logger.info({ repo, merge }, 'Merge completed');
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
    logger.error('Usage: deltix log <repo> [--branch=name] [--limit=N]');
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
    logger.info({ repo, log }, 'Repo log');
    return 0;
  } catch (err) {
    return handleVersioningError(err, 'Log failed');
  }
}

async function runDiff(args: string[]): Promise<number> {
  const [repo, from, to] = args;
  if (!repo || !from || !to) {
    logger.error('Usage: deltix diff <repo> <from> <to>');
    return 1;
  }

  try {
    const diff = await createVersioningService().getDiff(repo, from, to);
    logger.info({ repo, diff }, 'Repo diff');
    return 0;
  } catch (err) {
    return handleVersioningError(err, 'Diff failed');
  }
}

async function runRoles(args: string[]): Promise<number> {
  const [action, repo, username, role] = args;
  if (!action) {
    logger.error('Usage: deltix roles <list|grant|revoke> <repo> [username] [role]');
    return 1;
  }

  try {
    const service = createVersioningService();
    switch (action) {
      case 'list': {
        if (!repo) {
          logger.error('Usage: deltix roles list <repo>');
          return 1;
        }
        const roles = await service.listRoles(repo);
        logger.info({ repo, roles }, 'Repo roles');
        return 0;
      }
      case 'grant': {
        if (!repo || !username || !role || !['reader', 'writer', 'admin'].includes(role)) {
          logger.error('Usage: deltix roles grant <repo> <username> <reader|writer|admin>');
          return 1;
        }
        const assignment = await service.grantRole(
          repo,
          username,
          role as 'reader' | 'writer' | 'admin',
        );
        logger.info({ repo, assignment }, 'Repo role granted');
        return 0;
      }
      case 'revoke': {
        if (!repo || !username) {
          logger.error('Usage: deltix roles revoke <repo> <username>');
          return 1;
        }
        await service.revokeRole(repo, username);
        logger.info({ repo, username }, 'Repo role revoked');
        return 0;
      }
      default:
        logger.error('Usage: deltix roles <list|grant|revoke> <repo> [username] [role]');
        return 1;
    }
  } catch (err) {
    return handleVersioningError(err, 'Roles command failed');
  }
}

async function runSyncPrefs(args: string[]): Promise<number> {
  const [action, repo, mode, ...tables] = args;
  if (!action) {
    logger.error('Usage: deltix sync-prefs <get|set|dry-run> <repo> [mode] [tables...]');
    return 1;
  }

  try {
    const service = createVersioningService();
    switch (action) {
      case 'get': {
        if (!repo) {
          logger.error('Usage: deltix sync-prefs get <repo>');
          return 1;
        }
        const preference = await service.getSyncPreferences(repo);
        logger.info({ repo, preference }, 'Sync preferences');
        return 0;
      }
      case 'set': {
        if (!repo || !mode || !['schema-only', 'schema-and-data'].includes(mode)) {
          logger.error(
            'Usage: deltix sync-prefs set <repo> <schema-only|schema-and-data> [tables...]',
          );
          return 1;
        }
        const preference = await service.setSyncPreferences(
          repo,
          mode === 'schema-only' ? 'schema_only' : 'schema_and_data',
          normalizeTables(tables),
        );
        logger.info({ repo, preference }, 'Sync preferences updated');
        return 0;
      }
      case 'dry-run': {
        if (!repo) {
          logger.error('Usage: deltix sync-prefs dry-run <repo> [tables...]');
          return 1;
        }
        const requestedTables = mode ? [mode, ...tables] : tables;
        const plan = await service.dryRunSyncPreferences(
          repo,
          'schema_and_data',
          normalizeTables(requestedTables),
        );
        logger.info({ repo, plan }, 'Sync preferences dry run');
        return 0;
      }
      default:
        logger.error('Usage: deltix sync-prefs <get|set|dry-run> <repo> [mode] [tables...]');
        return 1;
    }
  } catch (err) {
    return handleVersioningError(err, 'Sync preferences command failed');
  }
}

function handleVersioningError(err: unknown, action: string): number {
  if (err instanceof NoActiveSessionError || err instanceof VersioningAuthenticationError) {
    logger.error('Not logged in. Run `deltix login` first.');
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
    logger.error({ err: err.message }, action);
    return 1;
  }
  logger.error({ err: String(err) }, action);
  return 1;
}

function handleDataflowError(err: unknown, action: string): number {
  if (err instanceof NoActiveSessionError || err instanceof TicketAuthenticationError) {
    logger.error('Not logged in. Run `deltix login` first.');
    return 1;
  }
  if (err instanceof LocalFileNotFoundError) {
    logger.error({ err: err.message }, action);
    return 1;
  }
  if (err instanceof TransferAbortedError) {
    logger.error({ err: err.message }, action);
    return 1;
  }
  logger.error({ err: String(err) }, action);
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
      logger.info('Deltix-Client versioning parity with Deltix-Server Fase 5');
      logger.info(
        'Usage: deltix <login|logout|whoami|push|pull|repo|branch|merge|log|diff|roles|sync-prefs> [...args]',
      );
      logger.info('  deltix repo create <repo>');
      logger.info('  deltix repo list');
      logger.info('  deltix repo get <repo>');
      logger.info('  deltix branch list <repo>');
      logger.info('  deltix branch create <repo> <name>');
      logger.info('  deltix branch checkout <repo> <name>');
      logger.info('  deltix branch delete <repo> <name>');
      logger.info('  deltix branch current <repo>');
      logger.info('  deltix merge <repo> <sourceBranch> [targetBranch]');
      logger.info('  deltix log <repo> [--branch=name] [--limit=N]');
      logger.info('  deltix diff <repo> <from> <to>');
      logger.info('  deltix roles list <repo>');
      logger.info('  deltix roles grant <repo> <username> <reader|writer|admin>');
      logger.info('  deltix roles revoke <repo> <username>');
      logger.info('  deltix sync-prefs get <repo>');
      logger.info('  deltix sync-prefs set <repo> <schema-only|schema-and-data> [tables...]');
      logger.info('  deltix sync-prefs dry-run <repo> [tables...]');
      return command ? 1 : 0;
  }
}

if (import.meta.main) {
  const exitCode = await runCli(process.argv.slice(2));
  process.exit(exitCode);
}
