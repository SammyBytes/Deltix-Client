import { createMysqlEmbeddedService } from '../../contexts/mysql-embedded';
import { DEFAULT_DOLT_PORT } from '../../shared/constants';
import { handleLocalServerError } from '../helpers/handle-local-server-error';
import { newLocalService } from '../helpers/newLocalService';
import { persistLocalPortIfExplicit } from '../helpers/persist-local-port';
import { resolveServerIdentity } from '../helpers/repo';
import { printInfo, printSuccess, printTable } from '../output';

export async function runStart(args: string[]): Promise<number> {
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

export async function runStop(args: string[]): Promise<number> {
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

export async function runStatus(args: string[]): Promise<number> {
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
