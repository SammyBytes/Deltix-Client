/**
 * ACL adapter translating Deltix-Client's session context to Deltix-Server's
 * REST auth API (`/api/v1/auth/*`). This is the only place that knows the
 * server's wire shape — the session context works with its own local types.
 */
import { InvalidCredentialsError, ServerUnreachableError } from '../contexts/session/errors';

export interface LoginTokens {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
}

export class AuthApiAdapter {
  constructor(private readonly serverUrl: string) {}

  async login(username: string, password: string): Promise<LoginTokens> {
    const res = await this.request('/api/v1/auth/login', { username, password });

    if (res.status === 401) {
      throw new InvalidCredentialsError();
    }
    if (!res.ok) {
      throw new Error(`Unexpected server response: ${res.status}`);
    }

    return (await res.json()) as LoginTokens;
  }

  async keepAlive(refreshToken: string): Promise<void> {
    const res = await this.request('/api/v1/auth/keep-alive', { refreshToken });
    if (!res.ok) {
      throw new Error(`Unexpected server response: ${res.status}`);
    }
  }

  async logout(refreshToken: string): Promise<void> {
    const res = await this.request('/api/v1/auth/logout', { refreshToken });
    if (!res.ok) {
      throw new Error(`Unexpected server response: ${res.status}`);
    }
  }

  private async request(path: string, body: unknown): Promise<Response> {
    try {
      return await fetch(`${this.serverUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new ServerUnreachableError(err);
    }
  }
}
