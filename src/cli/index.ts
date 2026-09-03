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
  NoActiveSessionError,
  ServerUnreachableError,
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
  VersioningLocalService,
} from '../contexts/versioning-local';
import { getClientBuildInfo } from '../shared/build-info';
import {
  DEFAULT_BRANCH,
  DEFAULT_DOLT_PORT,
  DEFAULT_MYSQL_PORT,
  DEFAULT_SERVER_PORT,
  DEFAULT_SERVER_URL,
} from '../shared/constants';
import { applyPersistedConfigDefaults, loadEnv } from '../shared/env';
import { buildFetchTlsOptions } from '../shared/http-tls';
import { runLogin, runLogout, runWhoami } from './commands/auth';
import { runPush } from './commands/push';
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

/**
 * Separate CLI flags from positional arguments so commands don't care
 * about ordering.  Anything starting with `-` is treated as a flag;
 * when a flag doesn't contain `=` and the next arg doesn't start with
 * `-`, the next arg is consumed as the flag's value (not a positional).
 *
 * Examples:
 *   splitPositionalsAndFlags(['-n', '5', 'hmc-sync'])
 *     → { positionals: ['hmc-sync'], flags: ['-n', '5'] }
 *   splitPositionalsAndFlags(['hmc-sync', '--branch=main'])
 *     → { positionals: ['hmc-sync'], flags: ['--branch=main'] }
 */
function splitPositionalsAndFlags(args: string[]): {
  positionals: string[];
  flags: string[];
} {
  const positionals: string[] = [];
  const flags: string[] = [];
  let i = 0;
  while (i < args.length) {
    if (args[i].startsWith('-')) {
      flags.push(args[i]);
      if (!args[i].includes('=') && i + 1 < args.length && !args[i + 1].startsWith('-')) {
        flags.push(args[i + 1]);
        i += 2;
      } else {
        i += 1;
      }
    } else {
      positionals.push(args[i]);
      i += 1;
    }
  }
  return { positionals, flags };
}

async function runPull(args: string[]): Promise<number> {
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

async function runFetch(args: string[]): Promise<number> {
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

/**
 * Reads a CLI flag value in any of the three POSIX-style forms:
 *   `--limit=5`   (long, equals-separated)
 *   `--limit 5`   (long, space-separated)
 *   `-n 5`        (short, space-separated)
 * The short form requires a separate value (the next arg) so that
 * `-n5` is not mis-parsed — operators almost always space it. Returns
 * `undefined` if the flag isn't present.
 *
 * Only long flags accept the `--flag=value` form (short flags can't
 * practically be `--n=5`, and supporting it would invite ambiguity).
 */
function parseFlagValue(args: string[], flagName: string): string | undefined {
  // Long form: --name=value
  const eq = args.find((a) => a.startsWith(`--${flagName}=`));
  if (eq) return eq.slice(flagName.length + 3);
  // Long form: --name value
  const li = args.indexOf(`--${flagName}`);
  if (li >= 0 && li + 1 < args.length) return args[li + 1];
  // Short form: -x value (single-char name)
  if (flagName.length === 1) {
    const si = args.indexOf(`-${flagName}`);
    if (si >= 0 && si + 1 < args.length) return args[si + 1];
  }
  return undefined;
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

async function runMerge(args: string[]): Promise<number> {
  const [repoArg, sourceBranch, targetBranch] = args;
  const repo = await resolveRepo(
    repoArg,
    'Usage: deltix merge <repo> <sourceBranch> [targetBranch]',
  );
  if (!repo || !sourceBranch) return 1;

  try {
    const merge = await createVersioningService().merge(repo, sourceBranch, targetBranch);
    printSuccess(`Merge completed for ${repo}${merge.fastForward ? ' (fast-forward)' : ''}`, {
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
    // Fallback to local Dolt merge when repo not on server (daily flow)
    if (
      err instanceof RepoNotFoundError ||
      err instanceof ServerUnreachableError ||
      err instanceof VersioningAuthenticationError ||
      err instanceof NoActiveSessionError
    ) {
      try {
        const identity = await resolveServerIdentity(repo);
        if (!identity) throw err;
        const local = await newLocalService();
        const result = await local.mergeBranches(identity, sourceBranch, targetBranch);
        if (result.conflicts > 0) {
          printError(`Merge failed with conflicts: ${result.conflicts} table(s)`);
          return 1;
        }
        printSuccess(
          `Merge completed locally for ${repo}${result.fastForward ? ' (fast-forward)' : ''}`,
          {
            source: sourceBranch,
            target: targetBranch ?? '(current)',
          },
        );
        return 0;
      } catch (localErr) {
        return handleVersioningError(localErr, 'Merge failed (local fallback)');
      }
    }
    return handleVersioningError(err, 'Merge failed');
  }
}

async function runCheckout(args: string[]): Promise<number> {
  const [branch, repoArg] = args;
  // Support both `deltix checkout <branch>` and `deltix checkout <branch> <repo>`
  const b = branch;
  const r = repoArg;
  if (!b) {
    printError('Usage: deltix checkout <branch> [<repo>]');
    return 1;
  }
  // If second arg looks like a repo (we have it), use it; else resolve from cwd
  const repo = r ? await resolveRepo(r, 'Usage: deltix checkout <branch> [<repo>]') : null;
  const identity = repo
    ? await resolveServerIdentity(repo)
    : await resolveServerIdentity(undefined);
  if (!identity) {
    printError('Usage: deltix checkout <branch> [<repo>]  (or run from a deltix init project)');
    return 1;
  }
  try {
    const local = await newLocalService();
    await local.checkout(identity, b);
    printSuccess(`Checked out ${b} in ${identity.repo}`);
    return 0;
  } catch (err) {
    return handleSyncError(err, 'Checkout failed');
  }
}

async function runLog(args: string[]): Promise<number> {
  // Separate flags from positionals so `deltix log -n 5 hmc-sync` works
  // regardless of flag position (like git log -n 5 <branch>).
  const { positionals, flags } = splitPositionalsAndFlags(args);
  const repoArg = positionals[0];
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

  // Local working-tree diff (Git-like): `deltix diff` / `deltix diff <repo> [table]`
  // shows what the app/ORM wrote to Dolt via the MySQL wire protocol.
  // Server diff (existing): `deltix diff <repo> <from> <to>`.
  if (!from || !to) {
    // 0 args: cwd project, 1 arg: repo, 2 args: repo + table
    let identity: { repo: string; projectRoot?: string } | null = null;
    let table: string | undefined;
    if (args.length === 0) {
      identity = await resolveServerIdentity(undefined);
    } else if (args.length === 1) {
      identity = await resolveServerIdentity(repoArg);
    } else if (args.length === 2) {
      identity = await resolveServerIdentity(repoArg);
      table = from;
    }
    if (!identity) {
      printError(
        'Usage: deltix diff [<repo> [<from> <to> | <table>]]  (no refs = working-tree diff)',
      );
      return 1;
    }
    try {
      const local = await newLocalService();
      const { raw } = await local.getWorkingDiffSummary(identity, table);
      if (!raw) {
        printInfo('No changes in working tree.');
        return 0;
      }
      printInfo(`Working-tree diff for ${identity.repo}${table ? ` / ${table}` : ''}:`);
      for (const line of raw.split('\n').filter(Boolean)) {
        printInfo(`  ${line}`);
      }
      printInfo('  (unstaged — `deltix status` for overview, `deltix commit -m "msg"` to stage)');
      return 0;
    } catch (err) {
      return handleSyncError(err, 'Diff failed');
    }
  }

  const repo = await resolveRepo(repoArg, 'Usage: deltix diff <repo> <from> <to>');
  if (!repo || !from || !to) return 1;

  try {
    const diff = await createVersioningService().getDiff(repo, from, to);
    // Server returns `{ fromRef, toRef, tables: [...] }`. The row table is
    // `diff.tables`, not `diff` itself — passing `diff` directly (and casting
    // away the type) was the source of the `rows.reduce is not a function` bug
    // when this command hit a real server response.
    printKeyValues({ repo, from, to });
    printTable(diff.tables as unknown as Array<Record<string, unknown>>);
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
 * so a first-time user isn't left to discover `DELTIX_*` env vars on
 * their own. Covers everything the client needs to talk to the server
 * and bring up the local Dolt engine:
 *
 *   - `serverUrl`              — REST URL of Deltix-Server
 *   - `httpTlsCaPath` / `httpTlsServerNameOverride`
 *                              — TLS trust for the REST endpoint
 *   - `localHost` / `localPort`  — bind address for the local Dolt SQL server
 *
 * Env vars, when set, still take precedence over this persisted config
 * (see shared/env.ts's `applyPersistedConfigDefaults`) — the wizard is
 * the human-friendly path; env vars are the CI / automation path.
 *
 * When the server uses HTTPS with a self-signed cert, offers to fetch it
 * automatically (Trust-On-First-Use, like an SSH host key) instead of
 * requiring the operator to manually copy a `.crt` file off the server —
 * the exact friction reported in production. The fetched certificate's
 * fingerprint is always shown for explicit confirmation before
 * anything is trusted or saved.
 */
async function runConfigure(): Promise<number> {
  printInfo('Deltix connection setup (Ctrl+C to cancel; press Enter to keep the default)');

  const serverUrl = await promptText('Deltix-Server REST URL', {
    default: DEFAULT_SERVER_URL,
  });

  // Parse out the host from the REST URL so we can fetch its TLS cert and
  // (when reached by bare IP) suggest a DNS name for SNI.
  const parsed = new URL(serverUrl);
  const host = parsed.hostname || '127.0.0.1';
  const port = parsed.port
    ? Number(parsed.port)
    : parsed.protocol === 'https:'
      ? 443
      : DEFAULT_SERVER_PORT;
  const isIpAddress = /^(\d{1,3}\.){3}\d{1,3}$|:/.test(host);

  let httpTlsCaPath: string | undefined;
  let httpTlsServerNameOverride: string | undefined;
  let autoSuggestedOverride: string | undefined;

  if (parsed.protocol === 'https:') {
    const wantsAutoFetch = await promptConfirm(
      'Server uses HTTPS. Does it use a self-signed certificate that needs to be trusted ' +
        '(fetch it automatically instead of copying a .crt file by hand)?',
      { default: true },
    );
    if (wantsAutoFetch) {
      const fetched = await autoFetchAndTrustCertificate(host, port);
      httpTlsCaPath = fetched?.path;
      autoSuggestedOverride =
        fetched?.dnsNames.find((name) => !/^(\d{1,3}\.){3}\d{1,3}$|:/.test(name)) ?? undefined;
    }

    if (isIpAddress) {
      // Fall back to a stable, sensible default when the certificate's SAN
      // didn't reveal a DNS name (e.g. a pre-existing cert with only an IP).
      const overrideDefault = autoSuggestedOverride ?? 'localhost';
      if (autoSuggestedOverride) {
        printInfo(
          `"${host}" is an IP address. TLS clients cannot verify a bare IP as a server name, ` +
            `so this connection uses the DNS name the server's certificate identifies as — ` +
            `suggested \`${autoSuggestedOverride}\` from the certificate.`,
        );
      } else {
        printInfo(
          `"${host}" is an IP address. TLS requires a DNS-style server name for certificate ` +
            'verification (SNI), so you must provide the name the server certificate was issued for.',
        );
      }
      httpTlsServerNameOverride = await promptText('TLS server name override', {
        default: overrideDefault,
      });
    }

    if (!httpTlsCaPath) {
      const caPathAnswer = await promptText(
        'Path to a CA certificate to trust (leave blank if the server uses a publicly-trusted certificate)',
        { default: '' },
      );
      if (caPathAnswer.trim() !== '') httpTlsCaPath = caPathAnswer.trim();
    }
  }

  const localHost = await promptText('Local Dolt SQL bind host', {
    default: '127.0.0.1',
  });
  const localPortRaw = await promptText('Local Dolt SQL port (must be free)', {
    default: DEFAULT_MYSQL_PORT,
  });
  const localPort = Number.parseInt(localPortRaw, 10);

  const store = new ConfigStore(defaultConfigPath);
  await store.save({
    serverUrl,
    httpTlsCaPath,
    httpTlsServerNameOverride,
    localHost,
    localPort: Number.isFinite(localPort) ? localPort : DEFAULT_MYSQL_PORT,
  });

  printSuccess(`Configuration saved to ${defaultConfigPath}`);
  printKeyValues({
    serverUrl,
    localHost,
    localPort: Number.isFinite(localPort) ? localPort : DEFAULT_MYSQL_PORT,
    httpTlsCaPath,
    httpTlsServerNameOverride,
  });
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

    // Git-like working-tree status (staged vs unstaged) — the missing piece
    // for the "ORM writes to Dolt" workflow. The app points to :3307, migrations
    // land in Dolt's working tree, and `deltix status` tells the operator what
    // changed without needing to re-import.
    // Fast path: when the server is running, query via MySQL wire protocol
    // (~50ms) instead of spawning two `dolt` CLI processes (~6s on Windows).
    try {
      const local = await newLocalService();
      const ws = await local.getStatus(identity, {
        host: '127.0.0.1',
        port: status.port,
      });
      if (ws.branch) {
        printInfo(`On branch ${ws.branch}`);
      }
      if (ws.clean) {
        printInfo('Working tree clean — nothing to commit.');
        printInfo(
          `Run a migration against Dolt (:${status.port ?? DEFAULT_DOLT_PORT}) and re-run \`deltix status\` to see changes.`,
        );
      } else {
        if (ws.staged.length > 0) {
          printInfo('Changes to be committed:');
          printTable(ws.staged.map((r) => ({ table: r.table, status: r.status })));
        }
        if (ws.unstaged.length > 0) {
          printInfo('Changes not staged for commit:');
          printTable(ws.unstaged.map((r) => ({ table: r.table, status: r.status })));
          printInfo('  (use `deltix commit -m "msg" [tables]` to stage and commit)');
        }
        // Hint for the "app points to Dolt" workflow
        if (ws.staged.length === 0 && ws.unstaged.length > 0) {
          printInfo(
            '  (all changes are unstaged — `deltix commit` will stage everything with `dolt add -A`)',
          );
        }
      }
    } catch {
      // No local repo yet (e.g. before first `deltix init`/`start`) — keep server
      // status output only, don't fail the command.
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
    case 'checkout':
      return runCheckout(rest);
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
        'Usage: deltix <version|configure|init|clone|import|commit|checkout|login|logout|whoami|push|pull|fetch|repo|branch|merge|log|diff|roles|sync-prefs|start|stop|status> [...args]',
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
        '  deltix checkout <branch> [<repo>]',
        '  deltix branch list [<repo>]',
        '  deltix branch local [<repo>]',
        '  deltix branch create [<repo>] <name>',
        '  deltix branch checkout [<repo>] <name>',
        '  deltix branch delete [<repo>] <name>',
        '  deltix branch current [<repo>]',
        '  deltix merge [<repo>] <sourceBranch> [targetBranch]',
        '  deltix log [<repo>] [--branch=name|-b name] [--limit=N|-n N]',
        '  deltix diff [<repo> [<from> <to> | <table>]]  (no refs = working-tree diff)',
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

export { parseFlagValue, persistLocalPortIfExplicit, splitPositionalsAndFlags };
