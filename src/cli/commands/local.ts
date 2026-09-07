import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  createLocalProjectService,
  InvalidRepoNameError,
  NoProjectError,
  ProjectAlreadyInitializedError,
} from '../../contexts/local-project';
import { createSessionService } from '../../contexts/session';
import {
  CommitDataDirNotFoundError,
  CommitEmptyError,
  CommitError,
  VersioningLocalService,
} from '../../contexts/versioning-local';
import { printError, printInfo, printLines, printSuccess, printWarn } from '../output';

export async function runInit(args: string[]): Promise<number> {
  const [repo] = args;
  if (!repo) {
    printError('Usage: deltix init <repo>');
    return 1;
  }
  try {
    const project = await createLocalProjectService().init(process.cwd(), repo);
    // dim the Dolt repo (the "git init" moment). If the Dolt binary
    // can't be resolved yet (e.g. first-run download needs network), don't
    // fail the bind — `deltix start` will initialize the repo then.
    try {
      const { BinaryManager } = await import('../../contexts/binary-manager');
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

export async function runCommit(args: string[]): Promise<number> {
  const messageArg = args.find((a) => !a.startsWith('-'));
  const flagArgs = args.filter((a) => a.startsWith('-'));
  const schemaOnly = flagArgs.includes('--schema-only');
  const message = messageArg;
  const tables = args.filter((a) => !a.startsWith('-') && a !== message);
  if (!message) {
    printError(
      schemaOnly
        ? 'Usage: deltix commit --schema-only <message>'
        : 'Usage: deltix commit <message> [tables...]',
    );
    return 1;
  }
  if (flagArgs.filter((a) => a !== '--schema-only').length > 0) {
    printError(`Unknown flag: ${flagArgs.filter((a) => a !== '--schema-only').join(' ')}`);
    return 1;
  }
  try {
    const project = await createLocalProjectService().resolve(process.cwd());
    const identity = { repo: project.config.repo, projectRoot: project.root };
    const { BinaryManager } = await import('../../contexts/binary-manager');
    // Use the logged-in user (if any) as the dolt commit author so audit
    // trails reflect who actually made the change. Falls back to the
    // historical 'deltix' identity when not logged in.
    const sessionStatus = await createSessionService().status();
    const authorName = sessionStatus.loggedIn ? sessionStatus.username : undefined;
    const commitOptions = authorName ? { authorName } : {};
    const service = new VersioningLocalService({
      homeDir: process.env.DELTIX_HOME ?? join(homedir(), '.deltix'),
      binaryManager: new BinaryManager(),
    });
    if (schemaOnly) {
      if (tables.length > 0) {
        printError(
          '--schema-only does not accept a table list; it analyses the whole working set.',
        );
        return 1;
      }
      const result = await service.commitSchemaOnly(identity, message, commitOptions);
      printSuccess(`Committed schema-only to ${result.repo}`, {
        commitHash: result.commitHash,
        message,
      });
      if (result.schemaTables.length > 0) {
        printLines([
          'Committed tables (DDL changes):',
          ...result.schemaTables.map((t) => `  ${t}`),
        ]);
      }
      if (result.dataOnlyTables.length > 0) {
        printLines([
          'Left uncommitted (row changes only — runtime/scratch data):',
          ...result.dataOnlyTables.map((t) => `  ${t}`),
        ]);
      }
      return 0;
    }
    if (tables.length === 0) {
      // A plain `deltix commit <message>` stages everything (`dolt add -A`),
      // which would publish runtime rows from tables the app writes to. Warn
      // so the operator can switch to `--schema-only` or name tables.
      try {
        const dataOnly = await service.dataOnlyChanges(identity);
        if (dataOnly.length > 0) {
          printWarn(
            `Publishing row changes in data-only tables (not schema changes): ${dataOnly.join(', ')}. ` +
              'Use `deltix commit --schema-only <message>` to publish only DDL, or name tables explicitly.',
          );
        }
      } catch {
        // The warning is best-effort; a failure here must not block the commit.
      }
    }
    const result = await service.commit(
      identity,
      message,
      tables.length > 0 ? tables : undefined,
      commitOptions,
    );
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
