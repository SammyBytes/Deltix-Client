/**
 * Orchestrates the client's session lifecycle: login (authenticate + persist
 * refresh token), logout (revoke server-side + clear local credentials),
 * and status (whether a local session exists). No business logic lives in
 * the CLI command handlers — it all lives here.
 */
import type { AuthApiAdapter } from '../../acl/auth-api-adapter';
import { CredentialsStore } from './credentials-store';
import { NoActiveSessionError } from './errors';

export interface SessionStatus {
  loggedIn: boolean;
  username?: string;
}

export class SessionService {
  private readonly credentialsStore: CredentialsStore;

  constructor(
    private readonly authApi: AuthApiAdapter,
    credentialsPath: string,
  ) {
    this.credentialsStore = new CredentialsStore(credentialsPath);
  }

  async login(username: string, password: string): Promise<void> {
    const { refreshToken } = await this.authApi.login(username, password);
    await this.credentialsStore.save({ refreshToken, username });
  }

  async logout(): Promise<void> {
    const credentials = await this.credentialsStore.load();
    if (!credentials) {
      throw new NoActiveSessionError();
    }

    try {
      await this.authApi.logout(credentials.refreshToken);
    } finally {
      // Fail-safe local logout: always clear the local credential even if
      // the server-side revoke call fails, so a compromised/unreachable
      // server can never keep a user "stuck" logged in on their own machine.
      await this.credentialsStore.clear();
    }
  }

  async keepAlive(): Promise<void> {
    const credentials = await this.credentialsStore.load();
    if (!credentials) {
      throw new NoActiveSessionError();
    }
    await this.authApi.keepAlive(credentials.refreshToken);
  }

  async status(): Promise<SessionStatus> {
    const credentials = await this.credentialsStore.load();
    if (!credentials) {
      return { loggedIn: false };
    }
    return { loggedIn: true, username: credentials.username };
  }
}
