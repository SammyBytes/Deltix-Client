import { describe, expect, it, mock } from 'bun:test';
import type { VersioningApiAdapter } from '../../../src/acl/versioning-api-adapter';
import { NoActiveSessionError, type SessionService } from '../../../src/contexts/session';
import {
  BranchAlreadyExistsError,
  BranchNotFoundError,
  InsufficientRoleError,
  MergeConflictError,
  ProtectedBranchError,
  RepoNotFoundError,
  RoleAssignmentNotFoundError,
  ValidationError,
  VersioningAuthenticationError,
  VersioningService,
} from '../../../src/contexts/versioning';

function fakeSessionService(overrides: Partial<SessionService> = {}): SessionService {
  return {
    mintAccessToken: mock(async () => 'access-token'),
    ...overrides,
  } as SessionService;
}

function fakeAdapter(overrides: Partial<VersioningApiAdapter> = {}): VersioningApiAdapter {
  return {
    createRepo: mock(async () => ({
      repoId: 'demo',
      doltPath: '/repo',
      createdAt: 1,
      createdBy: 'alice',
    })),
    listRepos: mock(async () => [
      { repoId: 'demo', doltPath: '/repo', createdAt: 1, createdBy: 'alice', role: 'admin' },
    ]),
    getRepo: mock(async () => ({
      repoId: 'demo',
      doltPath: '/repo',
      createdAt: 1,
      createdBy: 'alice',
      role: 'admin',
    })),
    listBranches: mock(async () => [{ name: 'main', isCurrent: true }]),
    createBranch: mock(async () => ({ name: 'feature/demo', isCurrent: false })),
    getCurrentBranch: mock(async () => 'main'),
    checkoutBranch: mock(async () => ({ name: 'feature/demo', isCurrent: true })),
    deleteBranch: mock(async () => undefined),
    merge: mock(async () => ({
      status: 'merged',
      sourceBranch: 'feature/demo',
      targetBranch: 'main',
      commitHash: 'abc',
      fastForward: false,
      message: 'ok',
    })),
    getLog: mock(async () => ({
      commits: [
        {
          commitHash: 'abc',
          author: 'alice',
          authorEmail: 'a@example.com',
          timestamp: '2026',
          message: 'msg',
          parents: [],
        },
      ],
      limit: 5,
    })),
    getDiff: mock(async () => ({ fromRef: 'main', toRef: 'feature/demo', tables: [] })),
    listRoles: mock(async () => [{ username: 'alice', repoId: 'demo', role: 'admin' }]),
    grantRole: mock(async () => ({ username: 'bob', repoId: 'demo', role: 'writer' })),
    revokeRole: mock(async () => undefined),
    getSyncPreferences: mock(async () => null),
    setSyncPreferences: mock(async () => ({ mode: 'schema_only', requestedTables: ['items'] })),
    dryRunSyncPreferences: mock(async () => ({
      mode: 'schema_and_data',
      requestedTables: ['orders'],
      autoIncludedTables: ['customers'],
    })),
    pushCommits: mock(async () => ({ commitHash: 'abc123' })),
    ...overrides,
  } as VersioningApiAdapter;
}

describe('versioning/versioning.service (unit, fake adapter)', () => {
  it('mints an access token before each adapter call', async () => {
    const sessionService = fakeSessionService();
    const adapter = fakeAdapter();
    const service = new VersioningService(sessionService, adapter);

    await service.listBranches('demo');
    await service.getCurrentBranch('demo');

    expect(sessionService.mintAccessToken).toHaveBeenCalledTimes(2);
  });

  it('provisions and fetches repos', async () => {
    const service = new VersioningService(fakeSessionService(), fakeAdapter());
    await expect(service.createRepo('demo')).resolves.toMatchObject({ repoId: 'demo' });
    await expect(service.listRepos()).resolves.toHaveLength(1);
    await expect(service.getRepo('demo')).resolves.toMatchObject({ repoId: 'demo' });
  });

  it('manages branches', async () => {
    const service = new VersioningService(fakeSessionService(), fakeAdapter());
    await expect(service.listBranches('demo')).resolves.toEqual([
      { name: 'main', isCurrent: true },
    ]);
    await expect(service.createBranch('demo', 'feature/demo')).resolves.toMatchObject({
      name: 'feature/demo',
    });
    await expect(service.getCurrentBranch('demo')).resolves.toBe('main');
    await expect(service.checkoutBranch('demo', 'feature/demo')).resolves.toMatchObject({
      isCurrent: true,
    });
    await expect(service.deleteBranch('demo', 'feature/demo')).resolves.toBeUndefined();
  });

  it('reads log, diff, roles, and sync preferences', async () => {
    const service = new VersioningService(fakeSessionService(), fakeAdapter());
    await expect(service.getLog('demo', { branch: 'main', limit: 5 })).resolves.toMatchObject({
      limit: 5,
    });
    await expect(service.getDiff('demo', 'main', 'feature/demo')).resolves.toMatchObject({
      fromRef: 'main',
    });
    await expect(service.listRoles('demo')).resolves.toHaveLength(1);
    await expect(service.grantRole('demo', 'bob', 'writer')).resolves.toMatchObject({
      username: 'bob',
    });
    await expect(service.revokeRole('demo', 'bob')).resolves.toBeUndefined();
    await expect(service.getSyncPreferences('demo')).resolves.toBeNull();
    await expect(
      service.setSyncPreferences('demo', 'schema_only', ['items']),
    ).resolves.toMatchObject({ mode: 'schema_only' });
    await expect(
      service.dryRunSyncPreferences('demo', 'schema_and_data', ['orders']),
    ).resolves.toMatchObject({ mode: 'schema_and_data' });
  });

  it('pushes commits to the server', async () => {
    const sessionService = fakeSessionService();
    const adapter = fakeAdapter();
    const service = new VersioningService(sessionService, adapter);

    const commits = [
      {
        message: 'feat: add orders',
        author: 'alice',
        tables: [{ name: 'orders', data: 'id,name\n1,order1' }],
      },
    ];
    const result = await service.pushCommits('demo', commits);

    expect(result.commitHash).toBe('abc123');
    expect(sessionService.mintAccessToken).toHaveBeenCalledTimes(1);
    expect(adapter.pushCommits).toHaveBeenCalledWith('access-token', 'demo', commits);
  });

  it('propagates session/authentication failures', async () => {
    const service = new VersioningService(
      fakeSessionService({
        mintAccessToken: mock(async () => {
          throw new NoActiveSessionError();
        }),
      }),
      fakeAdapter(),
    );
    await expect(service.listBranches('demo')).rejects.toThrow(NoActiveSessionError);

    const authService = new VersioningService(
      fakeSessionService(),
      fakeAdapter({
        listBranches: mock(async () => {
          throw new VersioningAuthenticationError();
        }),
      }),
    );
    await expect(authService.listBranches('demo')).rejects.toThrow(VersioningAuthenticationError);
  });

  it('propagates typed domain errors from adapter methods', async () => {
    const service = new VersioningService(
      fakeSessionService(),
      fakeAdapter({
        createBranch: mock(async () => {
          throw new BranchAlreadyExistsError('exists');
        }),
        checkoutBranch: mock(async () => {
          throw new BranchNotFoundError('missing');
        }),
        deleteBranch: mock(async () => {
          throw new ProtectedBranchError('protected');
        }),
        getRepo: mock(async () => {
          throw new RepoNotFoundError('repo');
        }),
        listRoles: mock(async () => {
          throw new InsufficientRoleError('denied');
        }),
        revokeRole: mock(async () => {
          throw new RoleAssignmentNotFoundError('missing');
        }),
        setSyncPreferences: mock(async () => {
          throw new ValidationError('bad');
        }),
      }),
    );

    await expect(service.createBranch('demo', 'feature')).rejects.toThrow(BranchAlreadyExistsError);
    await expect(service.checkoutBranch('demo', 'missing')).rejects.toThrow(BranchNotFoundError);
    await expect(service.deleteBranch('demo', 'main')).rejects.toThrow(ProtectedBranchError);
    await expect(service.getRepo('demo')).rejects.toThrow(RepoNotFoundError);
    await expect(service.listRoles('demo')).rejects.toThrow(InsufficientRoleError);
    await expect(service.revokeRole('demo', 'bob')).rejects.toThrow(RoleAssignmentNotFoundError);
    await expect(service.setSyncPreferences('demo', 'schema_only', null)).rejects.toThrow(
      ValidationError,
    );
  });

  it('propagates merge conflicts with structured payload', async () => {
    const service = new VersioningService(
      fakeSessionService(),
      fakeAdapter({
        merge: mock(async () => {
          throw new MergeConflictError('Merge conflict', 'feature/demo', 'main', [
            { table: 'items', count: 1, conflicts: [] },
          ]);
        }),
      }),
    );

    await expect(service.merge('demo', 'feature/demo')).rejects.toMatchObject({
      sourceBranch: 'feature/demo',
      targetBranch: 'main',
      conflicts: [{ table: 'items', count: 1 }],
    });
  });
});
