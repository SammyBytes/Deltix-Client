import { afterAll, describe, expect, it } from 'bun:test';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMysqlEmbeddedService } from '../../../src/contexts/mysql-embedded';
import { __resetEnvCacheForTests } from '../../../src/shared/env';

const doltBin = process.env.DELTIX_DOLT_BIN_PATH;
const available = Boolean(doltBin);

// Spins a real `dolt sql-server` on a throwaway port and exercises the full
// start -> status -> stop lifecycle against a real Dolt binary. Runs only in
// CI, where the workflow pre-installs a verified Dolt and exports
// DELTIX_DOLT_BIN_PATH (locally we skip to avoid a heavy download).
describe.skipIf(!available)(
  'mysql-embedded/mysql-embedded.service (integration, real Dolt binary)',
  () => {
    const home = join(tmpdir(), `deltix-me-it-${Date.now()}`);
    const port = 20_000 + Math.floor(Math.random() * 10_000);

    afterAll(async () => {
      await rm(home, { recursive: true, force: true });
    });

    it('starts a real dolt sql-server, reports it running, then stops it', {
      timeout: 60_000,
    }, async () => {
      // cold-start of dolt sql-server can take >5s (bun default)
      process.env.DELTIX_HOME = home;
      process.env.DELTIX_LOCAL_PORT = String(port);
      __resetEnvCacheForTests();

      const service = createMysqlEmbeddedService();
      const repo = 'it-repo';
      // Use a project root so the run exercises the per-checkout state path
      // (data dir under ~/.deltix/projects/<hash>), not just repo-name keying.
      const identity = { repo, projectRoot: home };

      const started = await service.start(identity);
      expect(started.port).toBe(port);

      const status = await service.status(identity);
      expect(status.running).toBe(true);
      expect(status.pid).toBe(started.pid);

      const stopped = await service.stop(identity);
      expect(stopped.stopped).toBe(true);

      const after = await service.status(identity);
      expect(after.running).toBe(false);
    });
  },
);
