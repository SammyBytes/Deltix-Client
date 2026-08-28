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
import { getClientBuildInfo } from '../shared/build-info';
import { applyPersistedConfigDefaults, loadEnv } from '../shared/env';
import {
  printError,
  printInfo,
  printKeyValues,
  printLines,
  printSuccess,
  printTable,
  promptConfirm,
  promptText,
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

  if (isIpAddress) {
    printInfo(
      `"${grpcHost}" is an IP address. TLS requires a DNS-style server name for certificate ` +
        'verification (SNI), so you must provide the name the server certificate was issued for.',
    );
    grpcTlsServerNameOverride = await promptText('TLS server name override', {
      default: 'localhost',
    });
  }

  const isHttps = serverUrl.trim().toLowerCase().startsWith('https://');
  if (isHttps) {
    const wantsAutoFetch = await promptConfirm(
      'Server uses HTTPS. Does it use a self-signed certificate that needs to be trusted ' +
        '(fetch it automatically instead of copying a .crt file by hand)?',
      { default: true },
    );
    if (wantsAutoFetch) {
      grpcTlsCaPath = await autoFetchAndTrustCertificate(grpcHost, grpcPort);
    }
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
 * to `~/.deltix/trusted-server.crt` and returns that path. Returns
 * `undefined` on failure or if the user declines to trust it, in which
 * case the caller falls back to prompting for a manual CA path.
 */
async function autoFetchAndTrustCertificate(
  host: string,
  port: number,
): Promise<string | undefined> {
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
  return DEFAULT_TRUSTED_CERT_PATH;
}

async function runVersion(): Promise<number> {
  const clientInfo = await getClientBuildInfo();
  printInfo('Deltix-Client');
  printKeyValues({
    version: clientInfo.version,
    commit: clientInfo.commit,
  });

  const env = loadEnv();
  try {
    const response = await fetch(new URL('/status', env.DELTIX_SERVER_URL), {
      signal: AbortSignal.timeout(3000),
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
    } else {
      printInfo(`Deltix-Server (${env.DELTIX_SERVER_URL}): unreachable (HTTP ${response.status})`);
    }
  } catch {
    // Version reporting must never fail the command outright just because
    // the server happens to be unreachable — the client's own version is
    // still valid, useful information on its own.
    printInfo(`Deltix-Server (${env.DELTIX_SERVER_URL}): unreachable`);
  }

  return 0;
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
        'Usage: deltix <version|configure|login|logout|whoami|push|pull|repo|branch|merge|log|diff|roles|sync-prefs> [...args]',
        '  deltix configure',
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
  const persisted = await new ConfigStore(defaultConfigPath).load();
  if (persisted) applyPersistedConfigDefaults(persisted);
  const exitCode = await runCli(process.argv.slice(2));
  process.exit(exitCode);
}
