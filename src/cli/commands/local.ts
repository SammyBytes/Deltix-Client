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
import { printError, printInfo, printSuccess } from '../output';

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
  const [message, ...tables] = args;
  if (!message) {
    printError('Usage: deltix commit <message> [tables...]');
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
