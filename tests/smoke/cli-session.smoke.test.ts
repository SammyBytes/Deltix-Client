import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import { runCli } from '../../src/cli';
import { __resetEnvCacheForTests } from '../../src/shared/env';

/**
 * End-to-end smoke test: boots a REAL Deltix-Server subprocess (black box,
 * invoked only via its public HTTP contract — never by importing its
 * source, per the MIT/BSL license separation rule) and drives the actual
 * Deltix-Client CLI against it over real HTTP.
 *
 * Skipped automatically if the sibling Deltix-Server checkout isn't present
 * (e.g. a CI job that only checks out this repo).
 */
const SERVER_REPO_PATH = join(import.meta.dir, '..', '..', '..', 'Deltix-Server');
const SERVER_ENTRYPOINT = join(SERVER_REPO_PATH, 'src', 'index.ts');
const serverAvailable = await Bun.file(SERVER_ENTRYPOINT).exists();

async function initTempDoltRepo(): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), 'deltix-dolt-repo-cli-smoke-'));
  await $`dolt config --global --add user.name deltix-test`.quiet().nothrow();
  await $`dolt config --global --add user.email deltix-test@example.com`.quiet().nothrow();
  await $`dolt --data-dir ${repoPath} init`.quiet().nothrow();
  return repoPath;
}

describe.if(serverAvailable)(
  'cli login/logout smoke test (real server subprocess, real HTTP)',
  () => {
    let repoPath: string;
    let credentialsPath: string;
    let httpPort: number;
    let serverProc: ReturnType<typeof Bun.spawn>;

    beforeAll(async () => {
      repoPath = await initTempDoltRepo();
      credentialsPath = join(
        await mkdtemp(join(tmpdir(), 'deltix-cli-creds-')),
        'credentials.json',
      );
      httpPort = 21000 + Math.floor(Math.random() * 9000);

      const keygen = await import(
        join(SERVER_REPO_PATH, 'tests', 'fixtures', 'license-fixtures.ts')
      );
      const { publicKeyBase64, privateKeyPem } = keygen.generateTestKeypair();
      const licenseKey = keygen.signLicensePayload(keygen.buildDefaultPayload(), privateKeyPem);
      const { privateKeyPem: jwtPrivateKeyPem, publicKeyPem: jwtPublicKeyPem } =
        keygen.generateTestJwtKeypairPem();
      const { hashPassword } = await import(
        join(SERVER_REPO_PATH, 'src', 'contexts', 'auth', 'password-authenticator.ts')
      );
      const localUsers = JSON.stringify([
        { username: 'alice', passwordHash: await hashPassword('s3cret-pass') },
      ]);

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
          DELTIX_LOCAL_USERS: localUsers,
          DELTIX_SESSION_DB_PATH: join(repoPath, '..', 'sessions.db'),
          HTTP_PORT: String(httpPort),
          LOG_PRETTY: 'false',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });

      await new Promise((resolve) => setTimeout(resolve, 800));
    });

    afterAll(async () => {
      serverProc.kill();
      await rm(repoPath, { recursive: true, force: true });
    });

    it('logs in, reports whoami, then logs out via the real CLI + real server', async () => {
      __resetEnvCacheForTests();
      process.env.DELTIX_SERVER_URL = `http://127.0.0.1:${httpPort}`;
      process.env.DELTIX_CREDENTIALS_PATH = credentialsPath;

      const loginExit = await runCli(['login', 'alice', 's3cret-pass']);
      expect(loginExit).toBe(0);

      const whoamiExit = await runCli(['whoami']);
      expect(whoamiExit).toBe(0);

      const logoutExit = await runCli(['logout']);
      expect(logoutExit).toBe(0);

      __resetEnvCacheForTests();
    });

    it('fails login with a non-zero exit code for wrong credentials', async () => {
      __resetEnvCacheForTests();
      process.env.DELTIX_SERVER_URL = `http://127.0.0.1:${httpPort}`;
      process.env.DELTIX_CREDENTIALS_PATH = credentialsPath;

      const exitCode = await runCli(['login', 'alice', 'wrong-password']);

      expect(exitCode).toBe(1);
      __resetEnvCacheForTests();
    });
  },
);
