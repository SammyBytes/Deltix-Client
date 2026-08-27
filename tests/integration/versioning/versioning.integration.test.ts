import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import { createSessionService } from '../../../src/contexts/session';
import { createVersioningService } from '../../../src/contexts/versioning';
import { __resetEnvCacheForTests } from '../../../src/shared/env';

const SERVER_REPO_PATH = join(import.meta.dir, '..', '..', '..', '..', 'Deltix-Server');
const SERVER_ENTRYPOINT = join(SERVER_REPO_PATH, 'src', 'index.ts');
const serverAvailable = await Bun.file(SERVER_ENTRYPOINT).exists();

describe.if(serverAvailable)('versioning integration (real server subprocess)', () => {
  let repoPath: string;
  let workDir: string;
  let httpPort: number;
  let grpcPort: number;
  let serverProc: ReturnType<typeof Bun.spawn>;

  beforeAll(async () => {
    repoPath = await mkdtemp(join(tmpdir(), 'deltix-client-versioning-dolt-'));
    workDir = await mkdtemp(join(tmpdir(), 'deltix-client-versioning-work-'));
    await $`dolt --data-dir ${repoPath} init`.quiet().nothrow();
    httpPort = 28000 + Math.floor(Math.random() * 1000);
    grpcPort = 50000 + Math.floor(Math.random() * 500);

    const keygen = await import(join(SERVER_REPO_PATH, 'tests', 'fixtures', 'license-fixtures.ts'));
    const { publicKeyBase64, privateKeyPem } = keygen.generateTestKeypair();
    const licenseKey = keygen.signLicensePayload(keygen.buildDefaultPayload(), privateKeyPem);
    const { privateKeyPem: jwtPrivateKeyPem, publicKeyPem: jwtPublicKeyPem } =
      keygen.generateTestJwtKeypairPem();
    const { generateSelfSignedCert } = await import(
      join(SERVER_REPO_PATH, 'tests', 'fixtures', 'tls-fixtures.ts')
    );
    const { certPath, keyPath } = await generateSelfSignedCert(workDir);

    serverProc = Bun.spawn(['bun', 'run', SERVER_ENTRYPOINT], {
      cwd: SERVER_REPO_PATH,
      env: {
        ...process.env,
        DELTIX_LICENSE_PUBLIC_KEY: publicKeyBase64,
        DELTIX_LICENSE_KEY: licenseKey,
        DELTIX_DOLT_REPO_PATH: repoPath,
        DELTIX_CLOCK_TOLERANCE_MS: '5000',
        DELTIX_JWT_PRIVATE_KEY: jwtPrivateKeyPem,
        DELTIX_JWT_PUBLIC_KEY: jwtPublicKeyPem,
        DELTIX_BOOTSTRAP_ADMIN_USERNAME: 'alice',
        DELTIX_BOOTSTRAP_ADMIN_PASSWORD: 's3cret-pass',
        DELTIX_SESSION_DB_PATH: join(workDir, 'sessions.db'),
        DELTIX_TICKET_DB_PATH: join(workDir, 'tickets.db'),
        DELTIX_TRANSFER_JOB_DB_PATH: join(workDir, 'jobs.db'),
        DELTIX_NAS_SIM_PATH: join(workDir, 'nas-sim'),
        DELTIX_STAGING_ROOT_PATH: join(workDir, 'staging'),
        DELTIX_NAS_SYNC_POLL_INTERVAL_MS: '300',
        DELTIX_USER_DB_PATH: join(workDir, 'users.db'),
        DELTIX_REPO_DB_PATH: join(workDir, 'repos.db'),
        DELTIX_DOLT_REPOS_ROOT_PATH: join(workDir, 'dolt-repos'),
        DELTIX_ADDON_TRUST_DB_PATH: join(workDir, 'addon-trust.db'),
        DELTIX_GRPC_PORT: String(grpcPort),
        DELTIX_GRPC_TLS_CERT_PATH: certPath,
        DELTIX_GRPC_TLS_KEY_PATH: keyPath,
        HTTP_PORT: String(httpPort),
        LOG_PRETTY: 'false',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    await new Promise((resolve) => setTimeout(resolve, 3000));
    __resetEnvCacheForTests();
    process.env.DELTIX_SERVER_URL = `http://127.0.0.1:${httpPort}`;
    process.env.DELTIX_CREDENTIALS_PATH = join(workDir, 'credentials.json');
    await createSessionService().login('alice', 's3cret-pass');
  }, 30000);

  afterAll(async () => {
    serverProc.kill();
    await rm(repoPath, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
    __resetEnvCacheForTests();
  });

  it('creates a repo and reads it back through the client context', async () => {
    const service = createVersioningService();
    const repo = await service.createRepo('client-versioning-it');
    expect(repo.repoId).toBe('client-versioning-it');

    const repos = await service.listRepos();
    expect(repos.some((entry) => entry.repoId === 'client-versioning-it')).toBe(true);

    const fetched = await service.getRepo('client-versioning-it');
    expect(fetched.repoId).toBe('client-versioning-it');
  });
});
