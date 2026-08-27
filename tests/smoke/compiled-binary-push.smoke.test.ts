import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';

/**
 * Regression test for a real production bug: `bun build --compile` embeds
 * JS/TS module code into the binary, but does NOT automatically bundle
 * arbitrary asset files referenced via `join(import.meta.dir, ...)` --
 * `proto/transfer.proto` was being resolved relative to the *source tree*,
 * which doesn't exist once compiled. A user running the compiled binary
 * from any directory other than a checkout of this repo hit
 * `ENOENT: no such file or directory, open '<cwd>/proto/transfer.proto'`
 * on every `push`/`pull`.
 *
 * This can ONLY be caught by actually compiling the binary and running it
 * (not `runCli()` in-process, which resolves `import.meta.dir` against the
 * real source tree and would never reproduce the bug) from a directory that
 * has no `proto/` folder at all -- exactly what a real end user's working
 * directory looks like.
 */
const SERVER_REPO_PATH = join(import.meta.dir, '..', '..', '..', 'Deltix-Server');
const SERVER_ENTRYPOINT = join(SERVER_REPO_PATH, 'src', 'index.ts');
const serverAvailable = await Bun.file(SERVER_ENTRYPOINT).exists();

async function initTempDoltRepo(): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), 'deltix-dolt-repo-compiled-binary-smoke-'));
  await $`dolt config --global --add user.name deltix-test`.quiet().nothrow();
  await $`dolt config --global --add user.email deltix-test@example.com`.quiet().nothrow();
  await $`dolt --data-dir ${repoPath} init`.quiet().nothrow();
  return repoPath;
}

describe.if(serverAvailable)(
  'compiled binary push/pull smoke test (real bun build --compile, no proto/ on disk)',
  () => {
    let repoPath: string;
    let workDir: string;
    let cleanCwd: string;
    let binaryPath: string;
    let httpPort: number;
    let grpcPort: number;
    let serverProc: ReturnType<typeof Bun.spawn>;
    let credentialsPath: string;
    let caCertPath: string;

    beforeAll(async () => {
      repoPath = await initTempDoltRepo();
      workDir = await mkdtemp(join(tmpdir(), 'deltix-compiled-binary-smoke-'));
      // A working directory with NO `proto/` subfolder and no relation to
      // this repo's source tree -- exactly what breaks the un-fixed code.
      cleanCwd = await mkdtemp(join(tmpdir(), 'deltix-compiled-binary-cwd-'));
      credentialsPath = join(workDir, 'credentials.json');
      httpPort = 25000 + Math.floor(Math.random() * 2000);
      grpcPort = 49000 + Math.floor(Math.random() * 2000);

      const cliRepoRoot = join(import.meta.dir, '..', '..');
      binaryPath = join(workDir, 'deltix-compiled-smoke-bin');
      const build =
        await $`bun build ${join(cliRepoRoot, 'src', 'cli', 'index.ts')} --compile --outfile ${binaryPath}`
          .quiet()
          .nothrow();
      if (build.exitCode !== 0) {
        throw new Error(`Failed to compile CLI binary: ${build.stderr.toString()}`);
      }

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
      caCertPath = certPath;

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
    }, 30_000);

    afterAll(async () => {
      serverProc.kill();
      await rm(repoPath, { recursive: true, force: true });
      await rm(workDir, { recursive: true, force: true });
      await rm(cleanCwd, { recursive: true, force: true });
    });

    function runCompiledBinary(args: string[]) {
      return Bun.spawn([binaryPath, ...args], {
        cwd: cleanCwd, // no proto/ folder here -- the exact bug scenario
        env: {
          ...process.env,
          DELTIX_SERVER_URL: `http://127.0.0.1:${httpPort}`,
          DELTIX_CREDENTIALS_PATH: credentialsPath,
          DELTIX_GRPC_HOST: '127.0.0.1',
          DELTIX_GRPC_PORT: String(grpcPort),
          DELTIX_GRPC_TLS_CA_PATH: caCertPath,
          DELTIX_GRPC_TLS_SERVER_NAME_OVERRIDE: 'localhost',
          DELTIX_HEARTBEAT_INTERVAL_MS: '5000',
          LOG_PRETTY: 'false',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
    }

    it('pushes and pulls a file byte-for-byte identical from a compiled binary run outside the source tree', async () => {
      const loginProc = runCompiledBinary(['login', 'alice', 's3cret-pass']);
      const loginExit = await loginProc.exited;
      expect(loginExit).toBe(0);

      const localFilePath = join(workDir, 'local-repo.dolt');
      const pulledFilePath = join(workDir, 'pulled-repo.dolt');
      const fileContents = 'deltix compiled-binary smoke bytes '.repeat(500);
      await writeFile(localFilePath, fileContents);

      const pushProc = runCompiledBinary(['push', 'org/compiled-binary-smoke-repo', localFilePath]);
      const [pushStdout, pushStderr] = await Promise.all([
        new Response(pushProc.stdout).text(),
        new Response(pushProc.stderr).text(),
      ]);
      const pushExit = await pushProc.exited;
      expect(pushExit, `stdout: ${pushStdout}\nstderr: ${pushStderr}`).toBe(0);
      // The exact bug this test guards against: the un-fixed code always
      // failed here with ENOENT on `proto/transfer.proto`, regardless of
      // repo/file arguments.
      expect(pushStderr).not.toContain('transfer.proto');

      await new Promise((resolve) => setTimeout(resolve, 1500));

      const pullProc = runCompiledBinary([
        'pull',
        'org/compiled-binary-smoke-repo',
        pulledFilePath,
      ]);
      const pullStderr = await new Response(pullProc.stderr).text();
      const pullExit = await pullProc.exited;
      expect(pullExit, pullStderr).toBe(0);

      const pulledContents = await readFile(pulledFilePath, 'utf8');
      expect(pulledContents).toBe(fileContents);
    }, 30_000);
  },
);
