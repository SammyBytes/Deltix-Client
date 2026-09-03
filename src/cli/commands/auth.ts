import { flagValue } from '../helpers/args';
import { printError, printInfo, printSuccess } from '../output';

export async function runLogin(args: string[]): Promise<number> {
  const [username, passwordArg] = args;
  if (!username) {
    printError(
      'Usage: deltix login <username> [password]  (interactive prompt when password is omitted)',
    );
    return 1;
  }

  const passwordFromFlag = flagValue(args, 'password');
  const password = passwordFromFlag ?? passwordArg ?? process.env.DELTIX_LOGIN_PASSWORD;

  if (!password && process.stdin.isTTY) {
    const pw = await promptSecret(`Password for ${username}`);
    await createSessionService().login(username, pw);
    printSuccess(`Logged in as ${username}`);
    return 0;
  }

  if (!password) {
    printError(
      'No password provided. Pass it as an argument, set DELTIX_LOGIN_PASSWORD, or run interactively.',
    );
    return 1;
  }

  const source =
    passwordFromFlag !== undefined
      ? 'flag'
      : passwordArg !== undefined
        ? 'argv'
        : process.env.DELTIX_LOGIN_PASSWORD != null
          ? 'env'
          : null;

  if (source === 'argv')
    printInfo('Note: password passed as a positional argument. It is now in your shell history.');
  else if (source === 'env')
    printInfo(
      'Note: password read from DELTIX_LOGIN_PASSWORD. Other processes on this host can read it via /proc.',
    );

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

export async function runLogout(): Promise<number> {
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

export async function runWhoami(): Promise<number> {
  const status = await createSessionService().status();
  if (status.loggedIn) printInfo(`Logged in as ${status.username}`);
  else printInfo('Not logged in');
  return 0;
}
