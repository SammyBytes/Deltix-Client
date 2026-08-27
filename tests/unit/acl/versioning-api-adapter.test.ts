import { afterEach, describe, expect, it } from 'bun:test';
import { VersioningApiAdapter } from '../../../src/acl/versioning-api-adapter';
import { ServerUnreachableError } from '../../../src/contexts/session';
import {
  BranchAlreadyExistsError,
  BranchNotFoundError,
  InsufficientRoleError,
  ProtectedBranchError,
  RepoAlreadyExistsError,
  RepoNotFoundError,
  RoleAssignmentNotFoundError,
  UserNotFoundError,
  ValidationError,
  VersioningAuthenticationError,
} from '../../../src/contexts/versioning';

describe('acl/versioning-api-adapter (unit, mocked fetch)', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('listBranches() sends bearer auth with string concatenation and parses branches', async () => {
    let capturedAuth = '';
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      capturedAuth = headers.authorization ?? '';
      return new Response(JSON.stringify({ branches: [{ name: 'main', isCurrent: true }] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const result = await new VersioningApiAdapter('http://127.0.0.1:9090').listBranches(
      'token',
      'demo',
    );
    expect(capturedAuth).toBe('Bearer token');
    expect(result).toEqual([{ name: 'main', isCurrent: true }]);
  });

  it('maps auth, role, and validation errors', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
      })) as unknown as typeof fetch;
    await expect(
      new VersioningApiAdapter('http://127.0.0.1:9090').listRepos('bad'),
    ).rejects.toThrow(VersioningAuthenticationError);

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'denied' }), {
        status: 403,
      })) as unknown as typeof fetch;
    await expect(
      new VersioningApiAdapter('http://127.0.0.1:9090').listRepos('bad'),
    ).rejects.toThrow(InsufficientRoleError);

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'Invalid request body' }), {
        status: 400,
      })) as unknown as typeof fetch;
    await expect(
      new VersioningApiAdapter('http://127.0.0.1:9090').createRepo('token', 'bad'),
    ).rejects.toThrow(ValidationError);
  });

  it('maps repo, branch, and protected branch errors', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'Repo not found' }), {
        status: 404,
      })) as unknown as typeof fetch;
    await expect(
      new VersioningApiAdapter('http://127.0.0.1:9090').getRepo('token', 'demo'),
    ).rejects.toThrow(RepoNotFoundError);

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'Branch not found' }), {
        status: 404,
      })) as unknown as typeof fetch;
    await expect(
      new VersioningApiAdapter('http://127.0.0.1:9090').checkoutBranch('token', 'demo', 'missing'),
    ).rejects.toThrow(BranchNotFoundError);

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'main is protected and cannot be deleted' }), {
        status: 409,
      })) as unknown as typeof fetch;
    await expect(
      new VersioningApiAdapter('http://127.0.0.1:9090').deleteBranch('token', 'demo', 'main'),
    ).rejects.toThrow(ProtectedBranchError);
  });

  it('maps branch/repo conflict responses', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'Branch already exists' }), {
        status: 409,
      })) as unknown as typeof fetch;
    await expect(
      new VersioningApiAdapter('http://127.0.0.1:9090').createBranch('token', 'demo', 'feature'),
    ).rejects.toThrow(BranchAlreadyExistsError);

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'Repo already provisioned' }), {
        status: 409,
      })) as unknown as typeof fetch;
    await expect(
      new VersioningApiAdapter('http://127.0.0.1:9090').createRepo('token', 'demo'),
    ).rejects.toThrow(RepoAlreadyExistsError);
  });

  it('maps role assignment and user lookup errors', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'User not found' }), {
        status: 404,
      })) as unknown as typeof fetch;
    await expect(
      new VersioningApiAdapter('http://127.0.0.1:9090').grantRole(
        'token',
        'demo',
        'ghost',
        'reader',
      ),
    ).rejects.toThrow(UserNotFoundError);

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'Repo role assignment not found' }), {
        status: 404,
      })) as unknown as typeof fetch;
    await expect(
      new VersioningApiAdapter('http://127.0.0.1:9090').revokeRole('token', 'demo', 'ghost'),
    ).rejects.toThrow(RoleAssignmentNotFoundError);
  });

  it('maps merge conflicts with structured payload', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: 'Merge conflict',
          merge: {
            sourceBranch: 'feature/conflict',
            targetBranch: 'main',
            conflicts: [{ table: 'items', count: 1, conflicts: [] }],
          },
        }),
        { status: 409 },
      )) as unknown as typeof fetch;

    await expect(
      new VersioningApiAdapter('http://127.0.0.1:9090').merge('token', 'demo', 'feature/conflict'),
    ).rejects.toMatchObject({
      sourceBranch: 'feature/conflict',
      targetBranch: 'main',
      conflicts: [{ table: 'items', count: 1 }],
    });
  });

  it('wraps network errors', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    await expect(
      new VersioningApiAdapter('http://127.0.0.1:9090').listRepos('token'),
    ).rejects.toThrow(ServerUnreachableError);
  });
});
