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
    default:
      logger.info('Deltix-Client — see roadmap phases for feature implementation');
      logger.info('Usage: deltix <login|logout|whoami|push|pull> [...args]');
      return command ? 1 : 0;
  }
}

if (import.meta.main) {
  const exitCode = await runCli(process.argv.slice(2));
  process.exit(exitCode);
}
