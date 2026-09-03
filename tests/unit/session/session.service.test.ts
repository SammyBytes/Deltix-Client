import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthApiAdapter } from '../../../src/acl/auth-api-adapter';
import {
  InvalidCredentialsError,
  NoActiveSessionError,
} from '../../../src/contexts/session/errors';
import { SessionService } from '../../../src/contexts/session/session.service';

function fakeAdapter(overrides: Partial<AuthApiAdapter> = {}): AuthApiAdapter {
  return {
    login: async () => ({ accessToken: 'a.b.c', refreshToken: 'r1', expiresInSeconds: 900 }),
    logout: async () => undefined,
    keepAlive: async () => undefined,
    refresh: async () => ({
      accessToken: 'new-access-token',
      refreshToken: 'r1',
      expiresInSeconds: 900,
      username: 'alice',
    }),
    ...overrides,
  } as AuthApiAdapter;
}

describe('session/session.service (unit, fake adapter + real credentials file)', () => {
  it('login() authenticates and persists the refresh token locally', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deltix-session-'));
    const service = new SessionService(fakeAdapter(), join(dir, 'credentials.json'));

    await service.login('alice', 's3cret');
    const status = await service.status();

    expect(status).toEqual({ loggedIn: true, username: 'alice' });
    await rm(dir, { recursive: true, force: true });
  });

  it('login() propagates InvalidCredentialsError without persisting anything', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deltix-session-'));
    const adapter = fakeAdapter({
      login: async () => {
        throw new InvalidCredentialsError();
      },
    });
    const service = new SessionService(adapter, join(dir, 'credentials.json'));

    await expect(service.login('alice', 'wrong')).rejects.toThrow(InvalidCredentialsError);
    expect(await service.status()).toEqual({ loggedIn: false });
    await rm(dir, { recursive: true, force: true });
  });

  it('logout() revokes the session server-side and clears local credentials', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deltix-session-'));
    let loggedOutToken: string | undefined;
    const adapter = fakeAdapter({
      logout: async (token: string) => {
        loggedOutToken = token;
      },
    });
    const service = new SessionService(adapter, join(dir, 'credentials.json'));

    await service.login('alice', 's3cret');
    await service.logout();

    expect(loggedOutToken).toBe('r1');
    expect(await service.status()).toEqual({ loggedIn: false });
    await rm(dir, { recursive: true, force: true });
  });

  it('logout() throws NoActiveSessionError when not logged in', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deltix-session-'));
    const service = new SessionService(fakeAdapter(), join(dir, 'credentials.json'));

    await expect(service.logout()).rejects.toThrow(NoActiveSessionError);
    await rm(dir, { recursive: true, force: true });
  });

  it('logout() clears local credentials even if the server call fails (fail-safe local logout)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deltix-session-'));
    const adapter = fakeAdapter({
      logout: async () => {
        throw new Error('server unreachable');
      },
    });
    const service = new SessionService(adapter, join(dir, 'credentials.json'));

    await service.login('alice', 's3cret');
    await expect(service.logout()).rejects.toThrow('server unreachable');
    expect(await service.status()).toEqual({ loggedIn: false });
    await rm(dir, { recursive: true, force: true });
  });

  it('mintAccessToken() refreshes and returns a fresh access token', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deltix-session-'));
    const adapter = fakeAdapter({
      refresh: async (token: string) => ({
        accessToken: `access-for-${token}`,
        refreshToken: 'r2',
        expiresInSeconds: 900,
        username: 'alice',
      }),
    });
    const service = new SessionService(adapter, join(dir, 'credentials.json'));

    await service.login('alice', 's3cret');
    const accessToken = await service.mintAccessToken();

    expect(accessToken).toBe('access-for-r1');
    await rm(dir, { recursive: true, force: true });
  });

  it('mintAccessToken() persists a rotated refresh token so subsequent calls keep working', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deltix-session-'));
    let refreshCallCount = 0;
    const adapter = fakeAdapter({
      refresh: async (_token: string) => {
        refreshCallCount += 1;
        return {
          accessToken: `access-${refreshCallCount}`,
          refreshToken: `rotated-${refreshCallCount}`,
          expiresInSeconds: 900,
          username: 'alice',
        };
      },
    });
    const service = new SessionService(adapter, join(dir, 'credentials.json'));

    await service.login('alice', 's3cret');
    await service.mintAccessToken();
    await service.mintAccessToken();

    expect(refreshCallCount).toBe(2);
    await rm(dir, { recursive: true, force: true });
  });

  it('mintAccessToken() throws NoActiveSessionError when not logged in', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deltix-session-'));
    const service = new SessionService(fakeAdapter(), join(dir, 'credentials.json'));

    await expect(service.mintAccessToken()).rejects.toThrow(NoActiveSessionError);
    await rm(dir, { recursive: true, force: true });
  });
});
