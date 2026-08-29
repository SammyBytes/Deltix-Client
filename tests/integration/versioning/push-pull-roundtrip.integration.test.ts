import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import { computeLocalDataDir } from '../../../src/contexts/mysql-embedded';
import { createSessionService } from '../../../src/contexts/session';
import { createVersioningService } from '../../../src/contexts/versioning';
import { VersioningLocalService } from '../../../src/contexts/versioning-local';
import { __resetEnvCacheForTests } from '../../../src/shared/env';

const SERVER_REPO_PATH = join(import.meta.dir, '..', '..', '..', '..', 'Deltix-Server');
const SERVER_ENTRYPOINT = join(SERVER_REPO_PATH, 'src', 'index.ts');
const serverAvailable = await Bun.file(SERVER_ENTRYPOINT).exists();
const doltAvailable =
  (await $`which dolt`
    .quiet()
    .nothrow()
    .then((r) => r.exitCode === 0)) || Boolean(process.env.DELTIX_DOLT_BIN_PATH);

const REPO = 'roundtrip-repo';
const DOLT_BIN = process.env.DELTIX_DOLT_BIN_PATH ?? 'dolt';

function localService(homeDir: string): VersioningLocalService {
  return new VersioningLocalService({
    homeDir,
    binaryManager: { ensureInstalled: async () => DOLT_BIN },
  });
}

async function doltSql(dataDir: string, query: string): Promise<void> {
  await $`${DOLT_BIN} --data-dir ${dataDir} sql -q ${query}`.quiet();
}

async function doltCommit(dataDir: string, table: string, message: string): Promise<void> {
  await $`${DOLT_BIN} --data-dir ${dataDir} add ${table}`.quiet();
  await $`${DOLT_BIN} --data-dir ${dataDir} commit -m ${message} --author=deltix <deltix@deltix.local>`.quiet();
}

async function readCsv(dataDir: string, query: string): Promise<string> {
  const r = await $`${DOLT_BIN} --data-dir ${dataDir} sql -q ${query} -r csv`.quiet().nothrow();
  return r.stdout.toString().trim();
}

describe.if(serverAvailable && doltAvailable)(
  'push/pull roundtrip (real server + real dolt)',
  () => {
    let serverRepoPath: string;
    let workDir: string;
    let homeDir: string;
    let httpPort: number;
    let serverProc: ReturnType<typeof Bun.spawn>;

    beforeAll(async () => {
      serverRepoPath = await mkdtemp(join(tmpdir(), 'deltix-rt-server-'));
      workDir = await mkdtemp(join(tmpdir(), 'deltix-rt-work-'));
      homeDir = await mkdtemp(join(tmpdir(), 'deltix-rt-home-'));
      await $`dolt --data-dir ${serverRepoPath} init`.quiet().nothrow();
      httpPort = 28000 + Math.floor(Math.random() * 1000);

      const keygen = await import(
        join(SERVER_REPO_PATH, 'tests', 'fixtures', 'license-fixtures.ts')
      );
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
          DELTIX_DOLT_REPO_PATH: serverRepoPath,
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
          DELTIX_USER_DB_PATH: join(workDir, 'users.db'),
          DELTIX_REPO_DB_PATH: join(workDir, 'repos.db'),
          DELTIX_DOLT_REPOS_ROOT_PATH: join(workDir, 'dolt-repos'),
          DELTIX_ADDON_TRUST_DB_PATH: join(workDir, 'addon-trust.db'),
          DELTIX_GRPC_PORT: String(50000 + Math.floor(Math.random() * 500)),
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
      serverProc?.kill();
      await rm(serverRepoPath, { recursive: true, force: true });
      await rm(workDir, { recursive: true, force: true });
      await rm(homeDir, { recursive: true, force: true });
      __resetEnvCacheForTests();
    });

    async function makeCheckout(name: string): Promise<{
      svc: VersioningLocalService;
      id: { repo: string; projectRoot: string };
      dataDir: string;
    }> {
      const projectRoot = join(homeDir, name);
      await mkdir(projectRoot, { recursive: true });
      const svc = localService(homeDir);
      const id = { repo: REPO, projectRoot };
      await svc.initLocalRepo(id);
      return { svc, id, dataDir: computeLocalDataDir(homeDir, id) };
    }

    it('pushes from A, clones into B, syncs both ways, and surfaces a conflict', async () => {
      const versioning = createVersioningService();
      await versioning.createRepo(REPO);

      // --- A creates a table and pushes ---
      const a = await makeCheckout('a');
      await doltSql(
        a.dataDir,
        "CREATE TABLE customers (id INT PRIMARY KEY, name VARCHAR(50)); INSERT INTO customers VALUES (1,'Ana');",
      );
      await doltCommit(a.dataDir, 'customers', 'add customers');
      const aCommits = await a.svc.getUnpushedCommits(a.id, 'main');
      expect(aCommits.length).toBe(1);
      const pushA = await versioning.pushCommits(REPO, aCommits);
      expect(pushA.commitHash).toBeString();
      const aHead = await a.svc.getBranchHead(a.id, 'main');
      await a.svc.advanceRemoteRef(a.id, 'main', aHead!);

      // --- B clones (full pull) and sees the data ---
      const b = await makeCheckout('b');
      const pullB = await versioning.pullCommits(REPO, 'main', null);
      expect(pullB.commits.length).toBe(1);
      expect(pullB.serverHead).toBeString();
      const bHead = await b.svc.applyCommits(b.id, 'main', pullB.commits);
      await b.svc.advanceRemoteRef(b.id, 'main', bHead);
      expect(await readCsv(b.dataDir, 'SELECT * FROM customers')).toContain('Ana');
      // B's table kept its primary key (schema came as DDL, not inferred).
      const bSchema = await $`${DOLT_BIN} --data-dir ${b.dataDir} schema export customers`
        .quiet()
        .nothrow();
      expect(bSchema.stdout.toString()).toMatch(/PRIMARY KEY/i);

      // --- B adds a row, pushes; A fast-forwards on pull ---
      await doltSql(b.dataDir, "INSERT INTO customers VALUES (2,'Beto');");
      await doltCommit(b.dataDir, 'customers', 'add Beto');
      const bCommits = await b.svc.getUnpushedCommits(b.id, 'main');
      await versioning.pushCommits(REPO, bCommits);
      const bNewHead = await b.svc.getBranchHead(b.id, 'main');
      await b.svc.advanceRemoteRef(b.id, 'main', bNewHead!);

      const aFrom = await a.svc.getRemoteHead(a.id, 'main');
      const aPull = await versioning.pullCommits(REPO, 'main', aFrom);
      expect(aPull.commits.length).toBe(1);
      const aMerged = await a.svc.applyCommits(a.id, 'main', aPull.commits);
      await a.svc.advanceRemoteRef(a.id, 'main', aMerged);
      expect(await readCsv(a.dataDir, 'SELECT * FROM customers ORDER BY id')).toContain('Beto');

      // --- Divergence: both change row 1 differently, A pulls -> conflict ---
      await doltSql(a.dataDir, "UPDATE customers SET name='AnaA' WHERE id=1;");
      await doltCommit(a.dataDir, 'customers', 'a-edit');
      await doltSql(b.dataDir, "UPDATE customers SET name='AnaB' WHERE id=1;");
      await doltCommit(b.dataDir, 'customers', 'b-edit');
      const bDivCommits = await b.svc.getUnpushedCommits(b.id, 'main');
      await versioning.pushCommits(REPO, bDivCommits);
      const bDivHead = await b.svc.getBranchHead(b.id, 'main');
      await b.svc.advanceRemoteRef(b.id, 'main', bDivHead!);

      // A is now divergent: it has an unpushed 'a-edit' and the server has 'b-edit'.
      const aDivFrom = await a.svc.getRemoteHead(a.id, 'main');
      const aDivPull = await versioning.pullCommits(REPO, 'main', aDivFrom);
      await a.svc.applyCommits(a.id, 'origin/main', aDivPull.commits);
      await a.svc.checkout(a.id, 'main');
      const merge = await a.svc.mergeFromRemote(a.id, 'main');
      expect(merge.status).toBe('conflicts');
      if (merge.status === 'conflicts') {
        expect(merge.conflicts.some((c) => c.table === 'customers')).toBe(true);
      }
      await a.svc.mergeAbort(a.id, 'main');
      const status = await $`${DOLT_BIN} --data-dir ${a.dataDir} status`.quiet().nothrow();
      expect(status.stdout.toString()).toContain('nothing to commit');
    }, 60000);
  },
);
