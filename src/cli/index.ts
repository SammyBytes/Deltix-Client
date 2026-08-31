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
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CertificateFetchError, fetchServerCertificate } from '../acl/certificate-bootstrap';
import { ConfigStore, defaultConfigPath } from '../contexts/config';
import {
  type BlobPolicy,
  createImportService,
  ImportBlobError,
  ImportDsnError,
  ImportError,
  ImportUnsupportedSchemeError,
} from '../contexts/import';
import {
  createLocalProjectService,
  InvalidRepoNameError,
  NoProjectError,
  ProjectAlreadyInitializedError,
  type ResolvedProject,
} from '../contexts/local-project';
import {
  createMysqlEmbeddedService,
  LocalServerNotRunningError,
  LocalServerPortInUseError,
  LocalServerStartError,
} from '../contexts/mysql-embedded';
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
  CommitDataDirNotFoundError,
  CommitEmptyError,
  CommitError,
  LocalRepoInitError,
  PushEmptyError,
  PushError,
  VersioningLocalService,
} from '../contexts/versioning-local';
import { getClientBuildInfo } from '../shared/build-info';
import { applyPersistedConfigDefaults, loadEnv } from '../shared/env';
import { buildFetchTlsOptions } from '../shared/http-tls';
import {
  printError,
  printInfo,
  printKeyValues,
  printLines,
  printSuccess,
  printTable,
  promptConfirm,
  promptSecret,
  promptText,
} from './output';

async function runLogin(args: string[]): Promise<number> {
  const [username, passwordArg] = args;
  if (!username) {
    printError(
      'Usage: deltix login <username> [password]  (interactive prompt when password is omitted)',
    );
    return 1;
  }

  // Resolve the secret with a clear preference order:
  //   1. --password=<value>  → explicit, for scripts that know what they're
  //                            doing and accept the shell-history exposure.
  //   2. positional arg      → kept for backward compatibility, but warn
  //                            so the operator knows it just hit ~/.zsh_history.
  //   3. TTY prompt          → masked (the safe default).
  //   4. DELTIX_LOGIN_PASSWORD env var → for non-interactive scripts; warn
  //                            once at use site because 'ps' leaks env.
  let password = flagValue(args, 'password') ?? passwordArg ?? process.env.DELTIX_LOGIN_PASSWORD;
  let passwordSource: 'flag' | 'argv' | 'env' | 'prompt' | null = password
    ? password === passwordArg
      ? 'argv'
      : password === process.env.DELTIX_LOGIN_PASSWORD
        ? 'env'
        : 'flag'
    : null;

  if (!password && process.stdin.isTTY) {
    password = await promptSecret(`Password for ${username}`);
    passwordSource = 'prompt';
  }

  if (!password) {
    printError(
      'No password provided. Pass it as an argument, set DELTIX_LOGIN_PASSWORD, or run interactively.',
    );
    return 1;
  }

  if (passwordSource === 'argv') {
    printInfo('Note: password passed as a positional argument. It is now in your shell history.');
  } else if (passwordSource === 'env') {
    printInfo(
      'Note: password read from DELTIX_LOGIN_PASSWORD. Other processes on this host can read it via /proc.',
    );
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

    // Advance the remote-tracking ref so the next push only sends new work.
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
    if (err instanceof NoProjectError) {
      printError(String(err.message));
      return 1;
    }
    if (err instanceof CommitDataDirNotFoundError) {
      printError(String(err.message));
      return 1;
    }
    if (err instanceof LocalRepoInitError) {
      printError(String(err.message));
      return 1;
    }
    if (err instanceof PushEmptyError) {
      printInfo(String(err.message));
      return 0;
    }
    if (err instanceof PushError) {
      printError(String(err.message));
      return 1;
    }
    if (err instanceof VersioningAuthenticationError) {
      printError('Authentication failed. Run `deltix login` first.');
      return 1;
    }
    if (err instanceof InsufficientRoleError) {
      printError(String(err.message));
      return 1;
    }
    if (err instanceof RepoNotFoundError) {
      printError(String(err.message));
      return 1;
    }
    printError(`Push failed: ${String(err)}`);
    return 1;
  }
}

async function newLocalService(): Promise<VersioningLocalService> {
  const { BinaryManager } = await import('../contexts/binary-manager');
  return new VersioningLocalService({
    homeDir: process.env.DELTIX_HOME ?? join(homedir(), '.deltix'),
    binaryManager: new BinaryManager(),
  });
}

function handleSyncError(err: unknown, action: string): number {
  if (
    err instanceof NoProjectError ||
    err instanceof CommitDataDirNotFoundError ||
    err instanceof LocalRepoInitError ||
    err instanceof PushError ||
    err instanceof InsufficientRoleError ||
    err instanceof RepoNotFoundError ||
    err instanceof ValidationError
  ) {
    printError(String(err.message));
    return 1;
  }
  if (err instanceof VersioningAuthenticationError || err instanceof NoActiveSessionError) {
    printError('Authentication failed. Run `deltix login` first.');
    return 1;
  }
  printError(`${action}: ${String(err)}`);
  return 1;
}

async function runPull(args: string[]): Promise<number> {
  const abort = args.includes('--abort');
  const positional = args.filter((a) => !a.startsWith('--'));
  const repoArg = positional[0];
  const destFile = positional[1];

  // Transitional legacy path: whole-file gRPC pull, behind
  // DELTIX_ENABLE_GRPC_TRANSFER. Removed once the native commit-based pull is
  // confirmed in production.
  if (loadEnv().DELTIX_ENABLE_GRPC_TRANSFER && repoArg && destFile) {
    const { createDataflowService } = await import('../contexts/dataflow');
    try {
      const result = await createDataflowService().pull(repoArg, destFile);
      printSuccess(`[legacy gRPC] Pull completed for ${repoArg}`, {
        bytesReceived: result.bytesReceived,
        checksum: result.checksum,
      });
      return 0;
    } catch (err) {
      printError(`Pull failed (legacy gRPC): ${String(err)}`);
      return 1;
    }
  }

  const identity = await resolveServerIdentity(repoArg);
  if (!identity) {
    return 1;
  }
  const branch = 'main';
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

async function runFetch(args: string[]): Promise<number> {
  const [repoArg] = args;
  const identity = await resolveServerIdentity(repoArg);
  if (!identity) {
    return 1;
  }
  const branch = 'main';
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

async function runClone(args: string[]): Promise<number> {
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
    const { commits } = await createVersioningService().pullCommits(repo, 'main', null);
    if (commits.length > 0) {
      const head = await local.applyCommits(identity, 'main', commits);
      await local.advanceRemoteRef(identity, 'main', head);
    }
    printSuccess(`Cloned ${repo} into ${targetDir}`, { commits: commits.length });
    printInfo(`Next: cd ${repo} && deltix start`);
    return 0;
  } catch (err) {
    return handleSyncError(err, 'Clone failed');
  }
}

function flagValue(args: string[], name: string): string | undefined {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) {
    return eq.slice(name.length + 3);
  }
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function flagMulti(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    if (a.startsWith(`--${name}=`)) {
      out.push(a.slice(name.length + 3));
    } else if (a === `--${name}` && args[i + 1]) {
      out.push(args[i + 1] as string);
    }
  }
  return out;
}

async function runImport(args: string[]): Promise<number> {
  const repoArg = args.find((a) => !a.startsWith('--'));
  const from = flagValue(args, 'from') ?? process.env.DELTIX_IMPORT_URL;
  if (!repoArg || !from) {
    printError(
      'Usage: deltix import <repo> --from <mysql://dsn> [--table t] [--schema-only] [--continue] [--no-commit] [--blobs error|base64|skip]',
    );
    return 1;
  }
  const blobsRaw = flagValue(args, 'blobs');
  const blobs = (
    blobsRaw === 'base64' || blobsRaw === 'skip' || blobsRaw === 'error' ? blobsRaw : 'error'
  ) as BlobPolicy;
  const schemaOnly = args.includes('--schema-only');
  const continueOnRowError =
    args.includes('--continue') || args.includes('--continue-on-row-error');

  // When the operator didn't pick a mode AND the terminal is interactive,
  // ask once with a sensible default (schema + data, the common case). In
  // non-TTY (CI, scripts) we silently default to schema + data so the
  // command stays batchable.
  let effectiveSchemaOnly = schemaOnly;
  if (!schemaOnly && process.stdin.isTTY) {
    const wantsData = await promptConfirm('Import schema AND data? (no = schema only)', {
      default: true,
    });
    if (!wantsData) effectiveSchemaOnly = true;
  }

  // Auto-prompt for the DB password when the DSN didn't carry one. Keeping
  // the secret out of the DSN (and therefore out of shell history and `ps`)
  // is the whole point.
  const dsnWithPromptedSecret = await maybePromptForDsnPassword(from);
  try {
    // Bind the folder to the repo (the "git init" moment); reuse if already bound.
    let project: ResolvedProject;
    try {
      project = await createLocalProjectService().init(process.cwd(), repoArg);
    } catch (err) {
      if (err instanceof ProjectAlreadyInitializedError) {
        project = await createLocalProjectService().resolve(process.cwd());
      } else {
        throw err;
      }
    }
    const identity = { repo: project.config.repo, projectRoot: project.root };
    const sessionStatus = await createSessionService().status();
    const authorName = sessionStatus.loggedIn ? sessionStatus.username : undefined;
    const result = await createImportService().import(identity, {
      from: dsnWithPromptedSecret,
      tables: flagMulti(args, 'table'),
      schemaOnly: effectiveSchemaOnly,
      continueOnRowError,
      noCommit: args.includes('--no-commit'),
      blobs,
      authorName,
    });
    printSuccess(`Imported ${result.tablesImported} table(s) from ${result.database}`, {
      commit: result.commitHash ?? '(not committed — --no-commit)',
    });
    for (const s of result.skipped) {
      printInfo(`skipped ${s.table}: ${s.reason}`);
    }
    printInfo('Next: deltix push');
    return 0;
  } catch (err) {
    if (
      err instanceof ImportDsnError ||
      err instanceof ImportUnsupportedSchemeError ||
      err instanceof ImportBlobError ||
      err instanceof ImportError ||
      err instanceof CommitDataDirNotFoundError ||
      err instanceof LocalRepoInitError ||
      err instanceof ProjectAlreadyInitializedError ||
      err instanceof InvalidRepoNameError
    ) {
      printError(err.message);
      return 1;
    }
    printError(`Import failed: ${String(err)}`);
    return 1;
  }
}

/**
 * If `dsn` parses and has no password (e.g. `mysql://root@host/db`), ask
 * for it interactively with a masked prompt and return the DSN with the
 * password filled in. If the DSN already carries a password, or the
 * operator hits Enter on the prompt (empty secret), return the input as-is.
 *
 * Non-TTY: skip the prompt silently — the operator is presumably scripting.
 */
async function maybePromptForDsnPassword(dsn: string): Promise<string> {
  if (!process.stdin.isTTY) return dsn;
  let parsed: URL;
  try {
    parsed = new URL(dsn);
  } catch {
    return dsn; // let the import service emit the proper DsnError later
  }
  if (parsed.password) return dsn;
  if (!parsed.username) return dsn;
  const secret = await promptSecret(`Password for ${parsed.username}@${parsed.hostname}`);
  if (secret === '') return dsn;
  parsed.password = secret;
  return parsed.toString();
}

function parseFlagValue(args: string[], flagName: string): string | undefined {
  return args.find((arg) => arg.startsWith(`--${flagName}=`))?.slice(flagName.length + 3);
}

function normalizeTables(args: string[]): string[] | null {
  return args.length > 0 ? args : null;
}

function branchUsage(): number {
  printError('Usage: deltix branch <list|local|create|checkout|delete|current> [repo] [name]');
  return 1;
}

function logMergeConflict(err: MergeConflictError): void {
  printError(
    `Merge failed with conflicts (source=${err.sourceBranch}, target=${err.targetBranch})`,
  );
  printTable(err.conflicts.map((conflict) => ({ table: conflict.table, count: conflict.count })));
}

/**
 * Resolves the repo for a server-only command (no local context needed).
 * If `repoArg` is given, use it. Otherwise fall back to the cwd project
 * (the same behaviour `deltix push` / `log` already had via
 * `resolveServerIdentity`). Mirrors the per-project model so the operator
 * rarely has to type the repo name.
 */
async function resolveRepo(repoArg: string | undefined, usage: string): Promise<string | null> {
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

async function resolveRepoAndName(
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

async function runBranch(args: string[]): Promise<number> {
  const [action, repoArg, nameArg] = args;
  if (!action) {
    return branchUsage();
  }

  try {
    const service = createVersioningService();
    switch (action) {
      case 'list': {
        const repo = await resolveRepo(repoArg, 'Usage: deltix branch list <repo>');
        if (!repo) return 1;
        const branches = await service.listBranches(repo);
        // Flatten {name, isCurrent} into readable columns with a '*' marker
        // for the active branch, instead of letting printTable serialise the
        // object as a JSON blob ("{\"name\":\"main\",\"isCurrent\":true}").
        printTable(
          branches.map((branch) => ({
            branch: branch.name + (branch.isCurrent ? '  *' : ''),
          })),
        );
        return 0;
      }
      case 'create': {
        const params = await resolveRepoAndName(
          repoArg,
          nameArg,
          'Usage: deltix branch create <repo> <name>',
        );
        if (!params) return 1;
        const branch = await service.createBranch(params.repo, params.name);
        // Spread the API response into flat key/value pairs instead of letting
        // printSuccess serialize the object as a single JSON blob on one
        // line (which is unreadable and looks like an error to operators).
        printSuccess(`Branch created in ${params.repo}`, {
          current: branch.currentBranch,
          created: branch.createdBranch,
        });
        return 0;
      }
      case 'checkout': {
        const params = await resolveRepoAndName(
          repoArg,
          nameArg,
          'Usage: deltix branch checkout <repo> <name>',
        );
        if (!params) return 1;
        const branch = await service.checkoutBranch(params.repo, params.name);
        printSuccess(`Checked out ${params.repo}`, {
          current: branch.currentBranch,
        });
        return 0;
      }
      case 'delete': {
        const params = await resolveRepoAndName(
          repoArg,
          nameArg,
          'Usage: deltix branch delete <repo> <name>',
        );
        if (!params) return 1;
        await service.deleteBranch(params.repo, params.name);
        printSuccess(`Branch deleted in ${params.repo}`, { deleted: params.name });
        return 0;
      }
      case 'current': {
        const repo = await resolveRepo(repoArg, 'Usage: deltix branch current <repo>');
        if (!repo) return 1;
        const branch = await service.getCurrentBranch(repo);
        printInfo(`Current branch for ${repo}: ${branch}`);
        return 0;
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
        printTable(repos.map((repo) => ({ repo })));
        return 0;
      }
      case 'get': {
        const repo = await resolveRepo(repoArg, 'Usage: deltix repo get <repo>');
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
  const [repoArg, sourceBranch, targetBranch] = args;
  const repo = await resolveRepo(
    repoArg,
    'Usage: deltix merge <repo> <sourceBranch> [targetBranch]',
  );
  if (!repo || !sourceBranch) return 1;

  try {
    const merge = await createVersioningService().merge(repo, sourceBranch, targetBranch);
    printSuccess(`Merge completed for ${repo}` + (merge.fastForward ? ' (fast-forward)' : ''), {
      source: merge.sourceBranch,
      target: merge.targetBranch,
      commitHash: merge.commitHash,
      status: merge.status,
    });
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
  const [repoArg, ...flags] = args;
  // Mirror `deltix push`: when no repo is given, fall back to the project
  // initialised in cwd so a developer doesn't have to remember the repo name
  // they typed at `deltix init` time. Without this, `deltix log` from inside a
  // working tree would print a usage error even though the project context is
  // unambiguous.
  let repo = repoArg;
  if (!repo) {
    try {
      const project = await createLocalProjectService().resolve(process.cwd());
      repo = project.config.repo;
    } catch (err) {
      if (err instanceof NoProjectError) {
        printError(
          'Usage: deltix log <repo> [--branch=name|-b name] [--limit=N|-n N]   (omit <repo> to use the cwd project)',
        );
        return 1;
      }
      throw err;
    }
  }

  // Accept both --branch=foo (long) and --branch foo or -b foo (shell-friendly).
  const branch = parseFlagValue(flags, 'branch') ?? flagValue(flags, 'b');
  const limitValue = parseFlagValue(flags, 'limit') ?? parseFlagValue(flags, 'n');
  const limit = limitValue ? Number(limitValue) : undefined;

  try {
    const log = await createVersioningService().getLog(repo, {
      ...(branch ? { branch } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    // Server returns `{ commits: [...], limit }`; printTable expects the row
    // array directly. The previous `log as unknown as Array<...>` cast hid the
    // shape mismatch and turned into a runtime `rows.reduce is not a function`
    // every time anyone ran `deltix log`.
    printTable(log.commits as unknown as Array<Record<string, unknown>>);
    return 0;
  } catch (err) {
    return handleVersioningError(err, 'Log failed');
  }
}

async function runDiff(args: string[]): Promise<number> {
  const [repoArg, from, to] = args;
  const repo = await resolveRepo(repoArg, 'Usage: deltix diff <repo> <from> <to>');
  if (!repo || !from || !to) return 1;

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

async function runSyncPrefsGet(
  service: ReturnType<typeof createVersioningService>,
  repoArg: string | undefined,
): Promise<number> {
  const repo = await resolveRepo(repoArg, 'Usage: deltix sync-prefs get <repo>');
  if (!repo) return 1;
  const preference = await service.getSyncPreferences(repo);
  printKeyValues((preference ?? {}) as Record<string, unknown>);
  return 0;
}

async function runSyncPrefsSet(
  service: ReturnType<typeof createVersioningService>,
  repoArg: string | undefined,
  mode: string | undefined,
  tables: string[],
): Promise<number> {
  const repo = await resolveRepo(
    repoArg,
    'Usage: deltix sync-prefs set <repo> <schema-only|schema-and-data> [tables...]',
  );
  if (!repo || !mode || !['schema-only', 'schema-and-data'].includes(mode)) return 1;
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
  repoArg: string | undefined,
  mode: string | undefined,
  tables: string[],
): Promise<number> {
  const repo = await resolveRepo(repoArg, 'Usage: deltix sync-prefs dry-run <repo> [tables...]');
  if (!repo) return 1;
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
  const [action, repoArg, mode, ...tables] = args;
  if (!action) {
    printError('Usage: deltix sync-prefs <get|set|dry-run> [repo] [mode] [tables...]');
    return 1;
  }

  try {
    const service = createVersioningService();
    switch (action) {
      case 'get':
        return runSyncPrefsGet(service, repoArg);
      case 'set':
        return runSyncPrefsSet(service, repoArg, mode, tables);
      case 'dry-run':
        return runSyncPrefsDryRun(service, repoArg, mode, tables);
      default:
        printError('Usage: deltix sync-prefs <get|set|dry-run> [repo] [mode] [tables...]');
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

/**
 * Interactive one-time connection setup. Persists to `~/.deltix/config.json`
 * so a first-time user isn't left to discover `DELTIX_GRPC_*`/
 * `DELTIX_HTTP_*` env vars on their own — in particular
 * `DELTIX_GRPC_TLS_SERVER_NAME_OVERRIDE`, which is required whenever the
 * server is reached by IP address (Node's TLS stack rejects IP addresses as
 * SNI ServerNames outright). Env vars, when set, still always take
 * precedence over this persisted config (see shared/env.ts's
 * `applyPersistedConfigDefaults`).
 *
 * When the server uses a self-signed certificate, offers to fetch it
 * automatically (Trust-On-First-Use, like an SSH host key) instead of
 * requiring the operator to manually copy a `.crt` file off the server —
 * the exact friction reported in production (missing path, `sudo` needing
 * a TTY over SSH, etc). The fetched certificate's fingerprint is always
 * shown for explicit confirmation before anything is trusted or saved.
 */
async function runConfigure(): Promise<number> {
  printInfo('Deltix connection setup (Ctrl+C to cancel; press Enter to keep the default)');

  const serverUrl = await promptText('Deltix-Server REST URL', {
    default: 'http://127.0.0.1:9090',
  });
  const grpcHost = await promptText('Deltix-Server gRPC host (hostname or IP)', {
    default: '127.0.0.1',
  });
  const grpcPortRaw = await promptText('Deltix-Server gRPC port', { default: '50051' });
  const grpcPort = Number.parseInt(grpcPortRaw, 10);

  const isIpAddress = /^(\d{1,3}\.){3}\d{1,3}$|:/.test(grpcHost);
  let grpcTlsServerNameOverride: string | undefined;
  let grpcTlsCaPath: string | undefined;

  // DNS names the server's certificate is actually valid for — read from the
  // fetched certificate so we can *suggest* the right server-name override
  // instead of hard-coding one. This is what makes bare-IP servers usable by
  // any company's clients without manual guesswork.
  let autoSuggestedOverride: string | undefined;

  const isHttps = serverUrl.trim().toLowerCase().startsWith('https://');
  if (isHttps) {
    const wantsAutoFetch = await promptConfirm(
      'Server uses HTTPS. Does it use a self-signed certificate that needs to be trusted ' +
        '(fetch it automatically instead of copying a .crt file by hand)?',
      { default: true },
    );
    if (wantsAutoFetch) {
      const fetched = await autoFetchAndTrustCertificate(grpcHost, grpcPort);
      grpcTlsCaPath = fetched?.path;
      autoSuggestedOverride =
        fetched?.dnsNames.find((name) => !/^(\d{1,3}\.){3}\d{1,3}$|:/.test(name)) ?? undefined;
    }
  }

  if (isIpAddress) {
    // Fall back to a stable, sensible default when the certificate's SAN
    // didn't reveal a DNS name (e.g. a pre-existing cert with only an IP).
    const overrideDefault = autoSuggestedOverride ?? 'localhost';
    if (autoSuggestedOverride) {
      printInfo(
        `"${grpcHost}" is an IP address. TLS clients cannot verify a bare IP as a server name, ` +
          `so this connection uses the DNS name the server's certificate identifies as — ` +
          `suggested \`${autoSuggestedOverride}\` from the certificate.`,
      );
    } else {
      printInfo(
        `"${grpcHost}" is an IP address. TLS requires a DNS-style server name for certificate ` +
          'verification (SNI), so you must provide the name the server certificate was issued for.',
      );
    }
    grpcTlsServerNameOverride = await promptText('TLS server name override', {
      default: overrideDefault,
    });
  }

  if (!grpcTlsCaPath) {
    const caPathAnswer = await promptText(
      'Path to a CA certificate to trust (leave blank if the server uses a publicly-trusted certificate)',
      { default: '' },
    );
    if (caPathAnswer.trim() !== '') grpcTlsCaPath = caPathAnswer.trim();
  }

  const store = new ConfigStore(defaultConfigPath);
  await store.save({
    serverUrl,
    grpcHost,
    grpcPort: Number.isFinite(grpcPort) ? grpcPort : undefined,
    grpcTlsCaPath,
    grpcTlsServerNameOverride,
  });

  printSuccess(`Configuration saved to ${defaultConfigPath}`);
  printKeyValues({ serverUrl, grpcHost, grpcPort, grpcTlsCaPath, grpcTlsServerNameOverride });
  return 0;
}

const DEFAULT_TRUSTED_CERT_PATH = join(homedir(), '.deltix', 'trusted-server.crt');

/**
 * Fetches the server's certificate over a raw TLS handshake (with
 * validation disabled for that single bootstrap connection only), shows
 * its fingerprint, and — only after explicit user confirmation — writes it
 * to `~/.deltix/trusted-server.crt` and returns that path along with the DNS
 * names the certificate is valid for (the natural server-name override).
 * Returns `undefined` on failure or if the user declines to trust it, in
 * which case the caller falls back to prompting for a manual CA path.
 */
async function autoFetchAndTrustCertificate(
  host: string,
  port: number,
): Promise<{ path: string; dnsNames: string[] } | undefined> {
  printInfo(`Connecting to ${host}:${port} to fetch the server's certificate...`);
  let fetched: Awaited<ReturnType<typeof fetchServerCertificate>>;
  try {
    fetched = await fetchServerCertificate(host, port);
  } catch (err) {
    const message = err instanceof CertificateFetchError ? err.message : String(err);
    printError(`Could not fetch the certificate automatically: ${message}`);
    printInfo('Falling back to manual entry.');
    return undefined;
  }

  printInfo('Certificate received:');
  printKeyValues({
    subject: fetched.subject,
    issuer: fetched.issuer,
    validTo: fetched.validTo,
    sha256Fingerprint: fetched.fingerprint256,
  });
  printInfo(
    'Verify this fingerprint matches the one shown by the server operator (e.g. in the ' +
      'install.sh summary) before trusting it — this is the same trust model as an SSH host key.',
  );

  const trusted = await promptConfirm('Trust this certificate?', { default: false });
  if (!trusted) {
    printInfo('Certificate not trusted. Falling back to manual entry.');
    return undefined;
  }

  await mkdir(join(homedir(), '.deltix'), { recursive: true });
  await writeFile(DEFAULT_TRUSTED_CERT_PATH, fetched.pem, { mode: 0o600 });
  printSuccess(`Certificate saved to ${DEFAULT_TRUSTED_CERT_PATH}`);
  return { path: DEFAULT_TRUSTED_CERT_PATH, dnsNames: fetched.dnsNames };
}

async function runVersion(): Promise<number> {
  const clientInfo = await getClientBuildInfo();
  printInfo('Deltix-Client');
  printKeyValues({
    version: clientInfo.version,
    commit: clientInfo.commit,
  });

  const env = loadEnv();
  // Same TLS config the data API uses — otherwise the probe fails with
  // "self signed certificate" against a TLS server with a self-signed
  // cert even though /api/v1/* requests succeed, just because the probe
  // passes through raw `fetch()` without a CA override.
  const tls = buildFetchTlsOptions({
    caCertPath: env.DELTIX_HTTP_TLS_CA_PATH,
    serverNameOverride: env.DELTIX_HTTP_TLS_SERVER_NAME_OVERRIDE,
  });
  // /status is a best-effort probe — the actual server isn't down just
  // because the status endpoint happened to time out or return non-2xx
  // (the API endpoints under /api/v1/* are a separate surface and were
  // visibly working). We only show the server section when /status
  // succeeds, otherwise we stay quiet rather than shouting "unreachable"
  // when commands still work.
  let serverShown = false;
  try {
    const response = await fetch(new URL('/status', env.DELTIX_SERVER_URL), {
      signal: AbortSignal.timeout(3000),
      ...(tls ? { tls } : {}),
    });
    if (response.ok) {
      const server = (await response.json()) as {
        version?: string;
        commit?: string;
        nodeEnv?: string;
      };
      printInfo(`Deltix-Server (${env.DELTIX_SERVER_URL})`);
      printKeyValues({
        version: server.version ?? 'unknown',
        commit: server.commit ?? 'unknown',
        env: server.nodeEnv ?? 'unknown',
      });
      serverShown = true;
    }
  } catch {
    // Swallowed — fall through to the explanation below.
  }
  if (!serverShown) {
    printInfo(
      `(server version probe unavailable; run any data command to confirm connectivity — ${env.DELTIX_SERVER_URL})`,
    );
  }

  return 0;
}

async function runInit(args: string[]): Promise<number> {
  const [repo] = args;
  if (!repo) {
    printError('Usage: deltix init <repo>');
    return 1;
  }
  try {
    const project = await createLocalProjectService().init(process.cwd(), repo);
    // Create the local Dolt repo (the "git init" moment). If the Dolt binary
    // can't be resolved yet (e.g. first-run download needs network), don't
    // fail the bind — `deltix start` will initialize the repo then.
    try {
      const { BinaryManager } = await import('../contexts/binary-manager');
      await new VersioningLocalService({
        homeDir: process.env.DELTIX_HOME ?? join(homedir(), '.deltix'),
        binaryManager: new BinaryManager(),
      }).initLocalRepo({ repo: project.config.repo, projectRoot: project.root });
    } catch (err) {
      printInfo(
        `Project bound, but the local Dolt engine wasn't created yet (${String(err)}). \`deltix start\` will initialize it.`,
      );
    }
    printSuccess(`Initialized Deltix project in ${project.root}`, {
      repo,
      config: project.configPath,
      branch: project.config.branch,
    });
    return 0;
  } catch (err) {
    if (err instanceof ProjectAlreadyInitializedError) {
      printError(`Already initialized: ${err.message}`);
      return 1;
    }
    if (err instanceof InvalidRepoNameError) {
      printError(String(err.message));
      return 1;
    }
    printError(`Init failed: ${String(err)}`);
    return 1;
  }
}

async function runCommit(args: string[]): Promise<number> {
  const [message, ...tables] = args;
  if (!message) {
    printError('Usage: deltix commit <message> [tables...]');
    return 1;
  }
  try {
    const project = await createLocalProjectService().resolve(process.cwd());
    const identity = { repo: project.config.repo, projectRoot: project.root };
    const { BinaryManager } = await import('../contexts/binary-manager');
    // Use the logged-in user (if any) as the dolt commit author so audit
    // trails reflect who actually made the change. Falls back to the
    // historical 'deltix' identity when not logged in.
    const sessionStatus = await createSessionService().status();
    const authorName = sessionStatus.loggedIn ? sessionStatus.username : undefined;
    const result = await new VersioningLocalService({
      homeDir: process.env.DELTIX_HOME ?? join(homedir(), '.deltix'),
      binaryManager: new BinaryManager(),
    }).commit(identity, message, tables.length > 0 ? tables : undefined, { authorName });
    printSuccess(`Committed to ${result.repo}`, {
      commitHash: result.commitHash,
      message,
    });
    return 0;
  } catch (err) {
    if (err instanceof NoProjectError) {
      printError(String(err.message));
      return 1;
    }
    if (err instanceof CommitDataDirNotFoundError) {
      printError(String(err.message));
      return 1;
    }
    if (err instanceof CommitEmptyError) {
      printError(String(err.message));
      return 1;
    }
    if (err instanceof CommitError) {
      printError(String(err.message));
      return 1;
    }
    printError(`Commit failed: ${String(err)}`);
    return 1;
  }
}

/**
 * Resolves the repo a local-server command operates on. When no repo name is
 * given, falls back to the nearest `deltix init`ed project (like git finding
 * `.git`), so `deltix start` makes sense inside a working tree. When a project
 * is found, its absolute root is threaded through so the local server state is
 * keyed per-checkout (switching projects never collides).
 */
async function resolveServerIdentity(
  repoArg: string | undefined,
): Promise<{ repo: string; projectRoot?: string } | null> {
  // When the repo is given explicitly (e.g. `deltix push hmc-sync`), still
  // try to thread the cwd's projectRoot through so the local data dir
  // resolves under <home>/projects/<projectRoot-hash>/<repo> instead of the
  // legacy <home>/repos/<repo> path. Without this, every command that
  // accepts a repo arg (push/pull/log/branch/...) loses access to the local
  // working tree that the project's `deltix init` set up.
  // Falls through to repo-only when there's no project at cwd OR the
  // project's bound repo doesn't match.
  const tryResolveProjectRoot = async (): Promise<{
    repo: string;
    projectRoot?: string;
  } | null> => {
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

async function runStart(args: string[]): Promise<number> {
  const [repoArg] = args;
  const identity = await resolveServerIdentity(repoArg);
  if (!identity) return 1;
  try {
    // Ensure the local Dolt repo exists (idempotent) before serving it, so
    // `start` works even if `init` deferred repo creation.
    const local = await newLocalService();
    await local.initLocalRepo(identity);
    const state = await createMysqlEmbeddedService().start(identity);
    printSuccess(`Local Dolt SQL server started for ${identity.repo}`, {
      host: '127.0.0.1',
      port: state.port,
      pid: state.pid,
      dataDir: state.dataDir,
    });
    // Remember the port the operator actually used so they don't have to
    // set DELTIX_LOCAL_PORT=... on every subsequent command. We only persist
    // when the env var was explicit — silent persistence of the default
    // would surprise anyone sharing the config file across hosts (e.g. dotfiles).
    await persistLocalPortIfExplicit(state.port);
    return 0;
  } catch (err) {
    return handleLocalServerError(err);
  }
}

/**
 * Saves `port` to the Deltix config when DELTIX_LOCAL_PORT is currently set
 * in the process environment (meaning the operator chose it explicitly).
 * Merges into the existing config so unrelated fields (server URL, TLS,
 * credentials paths) are preserved. No-op when DELTIX_LOCAL_PORT is unset
 * OR when the persisted port already matches.
 */
async function persistLocalPortIfExplicit(
  port: number,
  configPath: string = defaultConfigPath,
): Promise<void> {
  if (Bun.env.DELTIX_LOCAL_PORT === undefined) return;
  const store = new ConfigStore(configPath);
  const existing = (await store.load()) ?? {};
  if (existing.localPort === port) return;
  await store.save({ ...existing, localPort: port });
}

async function runStop(args: string[]): Promise<number> {
  const [repoArg] = args;
  const identity = await resolveServerIdentity(repoArg);
  if (!identity) return 1;
  try {
    await createMysqlEmbeddedService().stop(identity);
    printSuccess(`Local Dolt SQL server stopped for ${identity.repo}`);
    return 0;
  } catch (err) {
    return handleLocalServerError(err);
  }
}

async function runStatus(args: string[]): Promise<number> {
  const [repoArg] = args;
  const identity = await resolveServerIdentity(repoArg);
  if (!identity) return 1;
  try {
    const status = await createMysqlEmbeddedService().status(identity);
    if (status.running) {
      printSuccess(`Local Dolt SQL server is running for ${identity.repo}`, {
        host: '127.0.0.1',
        port: status.port,
        pid: status.pid,
        dataDir: status.dataDir,
      });
    } else {
      printInfo(`Local Dolt SQL server is not running for ${identity.repo}`);
    }
    return 0;
  } catch (err) {
    return handleLocalServerError(err);
  }
}

function handleLocalServerError(err: unknown): number {
  if (err instanceof LocalServerPortInUseError) {
    printError(err.message);
    return 2;
  }
  if (err instanceof LocalServerNotRunningError) {
    printError(err.message);
    return 1;
  }
  if (err instanceof LocalServerStartError) {
    printError(err.message);
    return 1;
  }
  printError(`Local server command failed: ${String(err)}`);
  return 1;
}

export async function runCli(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  switch (command) {
    case 'configure':
      return runConfigure();
    case 'version':
    case '--version':
    case '-v':
      return runVersion();
    case 'start':
      return runStart(rest);
    case 'stop':
      return runStop(rest);
    case 'status':
      return runStatus(rest);
    case 'init':
      return runInit(rest);
    case 'clone':
      return runClone(rest);
    case 'import':
      return runImport(rest);
    case 'commit':
      return runCommit(rest);
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
    case 'fetch':
      return runFetch(rest);
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
        'Usage: deltix <version|configure|init|clone|import|commit|login|logout|whoami|push|pull|fetch|repo|branch|merge|log|diff|roles|sync-prefs|start|stop|status> [...args]',
        'When run from a `deltix init`-ed working tree, [<repo>] becomes optional — the cwd project wins.',
        '  deltix configure',
        '  deltix init <repo>',
        '  deltix clone <repo>',
        '  deltix import <repo> --from <dsn>',
        '  deltix commit <message> [tables...]',
        '  deltix push [<repo>]',
        '  deltix pull [<repo>] [--abort]',
        '  deltix fetch [<repo>]',
        '  deltix start [<repo>]',
        '  deltix stop [<repo>]',
        '  deltix status [<repo>]',
        '  deltix repo create <repo>',
        '  deltix repo list',
        '  deltix repo get [<repo>]',
        '  deltix branch list [<repo>]',
        '  deltix branch local [<repo>]',
        '  deltix branch create [<repo>] <name>',
        '  deltix branch checkout [<repo>] <name>',
        '  deltix branch delete [<repo>] <name>',
        '  deltix branch current [<repo>]',
        '  deltix merge [<repo>] <sourceBranch> [targetBranch]',
        '  deltix log [<repo>] [--branch=name|-b name] [--limit=N|-n N]',
        '  deltix diff [<repo>] <from> <to>',
        '  deltix roles list [<repo>]',
        '  deltix roles grant [<repo>] <username> <reader|writer|admin>',
        '  deltix roles revoke [<repo>] <username>',
        '  deltix sync-prefs get [<repo>]',
        '  deltix sync-prefs set [<repo>] <schema-only|schema-and-data> [tables...]',
        '  deltix sync-prefs dry-run [<repo>] [tables...]',
      ]);
      return command ? 1 : 0;
  }
}

if (import.meta.main) {
  const persisted = await new ConfigStore(defaultConfigPath).load();
  if (persisted) applyPersistedConfigDefaults(persisted);
  const exitCode = await runCli(process.argv.slice(2));
  process.exit(exitCode);
}

export { persistLocalPortIfExplicit };
