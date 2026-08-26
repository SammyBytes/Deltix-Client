#!/usr/bin/env bun
/**
 * Deltix-Client CLI entrypoint.
 *
 * Presentation only: parses argv and delegates to the relevant bounded
 * context's public API. No business logic lives here (see
 * .github/copilot-instructions.md §2).
 */
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

export async function runCli(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  switch (command) {
    case 'login':
      return runLogin(rest);
    case 'logout':
      return runLogout();
    case 'whoami':
      return runWhoami();
    default:
      logger.info('Deltix-Client — see roadmap phases for feature implementation');
      logger.info('Usage: deltix <login|logout|whoami> [...args]');
      return command ? 1 : 0;
  }
}

if (import.meta.main) {
  const exitCode = await runCli(process.argv.slice(2));
  process.exit(exitCode);
}
