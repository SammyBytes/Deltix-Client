#!/usr/bin/env bun
import { ConfigStore, defaultConfigPath } from '../contexts/config';
import { applyPersistedConfigDefaults } from '../shared/env';
import { runRepo, runRoles } from './commands/admin';
import { runLogin, runLogout, runWhoami } from './commands/auth';
import { runBranch } from './commands/branch';
import { runCheckout, runMerge } from './commands/branching';
import { runConfigure } from './commands/configure';
import { runImport } from './commands/import';
import { runDiff, runLog } from './commands/inspect';
import { runCommit, runInit } from './commands/local';
import { runPush } from './commands/push';
import { runClone, runFetch, runPull } from './commands/remote';
import { runStart, runStatus, runStop } from './commands/server';
import { runSyncPrefs } from './commands/sync-prefs';
import { runVersion } from './commands/version';
import { printLines } from './output';

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

export { parseFlagValue, splitPositionalsAndFlags } from './helpers/args';
export { persistLocalPortIfExplicit } from './helpers/persist-local-port';
