import { afterEach, describe, expect, it } from 'bun:test';
import { AuthApiAdapter } from '../../../src/acl/auth-api-adapter';
import {
  InvalidCredentialsError,
  ServerUnreachableError,
} from '../../../src/contexts/session/errors';

describe('acl/auth-api-adapter (unit, mocked fetch)', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('login() posts credentials and returns the parsed token payload on 200', async () => {
    let capturedUrl: string | undefined;
    let capturedBody: unknown;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init.body as string);
      return new Response(
        JSON.stringify({ accessToken: 'a.b.c', refreshToken: 'r1', expiresInSeconds: 900 }),
        { status: 200 },
      );
    }) as typeof fetch;

    const adapter = new AuthApiAdapter('http://127.0.0.1:9090');
    const result = await adapter.login('alice', 's3cret');

    expect(capturedUrl).toBe('http://127.0.0.1:9090/api/v1/auth/login');
    expect(capturedBody).toEqual({ username: 'alice', password: 's3cret' });
    expect(result).toEqual({ accessToken: 'a.b.c', refreshToken: 'r1', expiresInSeconds: 900 });
  });

  it('login() throws InvalidCredentialsError on a 401 response', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'Invalid credentials' }), {
        status: 401,
      })) as typeof fetch;

    const adapter = new AuthApiAdapter('http://127.0.0.1:9090');

    await expect(adapter.login('alice', 'wrong')).rejects.toThrow(InvalidCredentialsError);
  });

  it('login() wraps a network failure in ServerUnreachableError', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;

    const adapter = new AuthApiAdapter('http://127.0.0.1:9090');

    await expect(adapter.login('alice', 's3cret')).rejects.toThrow(ServerUnreachableError);
  });

  it('logout() posts the refresh token and resolves on 200', async () => {
    let capturedUrl: string | undefined;
    globalThis.fetch = (async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    const adapter = new AuthApiAdapter('http://127.0.0.1:9090');
    await adapter.logout('r1');

    expect(capturedUrl).toBe('http://127.0.0.1:9090/api/v1/auth/logout');
  });

  it('keepAlive() posts the refresh token and resolves on 200', async () => {
    let capturedUrl: string | undefined;
    globalThis.fetch = (async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    const adapter = new AuthApiAdapter('http://127.0.0.1:9090');
    await adapter.keepAlive('r1');

    expect(capturedUrl).toBe('http://127.0.0.1:9090/api/v1/auth/keep-alive');
  });
});
