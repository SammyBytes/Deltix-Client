import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import { createDataflowService } from '../../../src/contexts/dataflow';
import { createSessionService } from '../../../src/contexts/session';
import { __resetEnvCacheForTests } from '../../../src/shared/env';

/**
 * Real cross-repo end-to-end integration test: boots an ACTUAL Deltix-Server
 * subprocess (black-box, only via its public HTTP/gRPC contract — never by
 * importing its source, per the MIT/BSL license separation rule), logs in
 * via the real `session` context, then drives the real `dataflow` context
 * to Push a file over real TLS gRPC and Pull it back, verifying the round
 * trip is byte-for-byte identical. This is the strongest evidence that
 * Fase 3's client<->server integration actually works end-to-end.
 *
 * Skipped automatically if the sibling Deltix-Server checkout isn't present
 * (e.g. a CI job that only checks out this repo).
 */
const SERVER_REPO_PATH = join(import.meta.dir, '..', '..', '..', '..', 'Deltix-Server');
const SERVER_ENTRYPOINT = join(SERVER_REPO_PATH, 'src', 'index.ts');
const serverAvailable = await Bun.file(SERVER_ENTRYPOINT).exists();

async function initTempDoltRepo(): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), 'deltix-dolt-repo-dataflow-it-'));
  await $`dolt config --global --add user.name deltix-test`.quiet().nothrow();
  await $`dolt config --global --add user.email deltix-test@example.com`.quiet().nothrow();
  await $`dolt --data-dir ${repoPath} init`.quiet().nothrow();
  return repoPath;
}

describe.if(serverAvailable)(
  'dataflow push/pull end-to-end (real Deltix-Server subprocess, real TLS gRPC)',
  () => {
    let repoPath: string;
    let workDir: string;
    let httpPort: number;
    let grpcPort: number;
    let serverProc: ReturnType<typeof Bun.spawn>;

    beforeAll(async () => {
      repoPath = await initTempDoltRepo();
      workDir = await mkdtemp(join(tmpdir(), 'deltix-dataflow-it-work-'));
      httpPort = 23000 + Math.floor(Math.random() * 2000);
      grpcPort = 47000 + Math.floor(Math.random() * 2000);

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
          DELTIX_LOCAL_USERS: localUsers,
          DELTIX_SESSION_DB_PATH: join(workDir, 'sessions.db'),
          DELTIX_TICKET_DB_PATH: join(workDir, 'tickets.db'),
          DELTIX_TRANSFER_JOB_DB_PATH: join(workDir, 'transfer-jobs.db'),
          DELTIX_NAS_SIM_PATH: join(workDir, 'nas-sim'),
          DELTIX_STAGING_ROOT_PATH: join(workDir, 'staging'),
          DELTIX_NAS_SYNC_POLL_INTERVAL_MS: '300',
          DELTIX_GRPC_PORT: String(grpcPort),
          DELTIX_GRPC_TLS_CERT_PATH: certPath,
          DELTIX_GRPC_TLS_KEY_PATH: keyPath,
          HTTP_PORT: String(httpPort),
          LOG_PRETTY: 'false',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });

      await new Promise((resolve) => setTimeout(resolve, 1500));

      // Point the client at this real server + its self-signed cert.
      __resetEnvCacheForTests();
      process.env.DELTIX_SERVER_URL = `http://127.0.0.1:${httpPort}`;
      process.env.DELTIX_CREDENTIALS_PATH = join(workDir, 'credentials.json');
      process.env.DELTIX_GRPC_HOST = '127.0.0.1';
      process.env.DELTIX_GRPC_PORT = String(grpcPort);
      process.env.DELTIX_GRPC_TLS_CA_PATH = certPath;
      process.env.DELTIX_GRPC_TLS_SERVER_NAME_OVERRIDE = 'localhost';
      process.env.DELTIX_HEARTBEAT_INTERVAL_MS = '5000';

      await createSessionService().login('alice', 's3cret-pass');
    });

    afterAll(async () => {
      serverProc.kill();
      await rm(repoPath, { recursive: true, force: true });
      await rm(workDir, { recursive: true, force: true });
      __resetEnvCacheForTests();
    });

    it('pushes a local file, waits for NAS sync, then pulls it back byte-for-byte identical', async () => {
      const localFilePath = join(workDir, 'local-repo.dolt');
      const pulledFilePath = join(workDir, 'pulled-repo.dolt');
      const fileContents = 'deltix repo bytes '.repeat(1000);
      await writeFile(localFilePath, fileContents);

      const pushResult = await createDataflowService().push('org/demo-repo', localFilePath);
      expect(pushResult.bytesSent).toBe(Buffer.byteLength(fileContents));
      expect(pushResult.checksum).toBeString();

      // Give the real NAS sync worker (independent poll loop) time to
      // promote the staged job before attempting the pull.
      await new Promise((resolve) => setTimeout(resolve, 1500));

      const pullResult = await createDataflowService().pull('org/demo-repo', pulledFilePath);
      expect(pullResult.checksum).toBe(pushResult.checksum);

      const pulledContents = await readFile(pulledFilePath, 'utf8');
      expect(pulledContents).toBe(fileContents);
    }, 20_000);
  },
);
