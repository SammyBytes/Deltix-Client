import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadEnv } from '../../shared/env';
import { BinaryManager } from '../binary-manager';
import { MysqlEmbeddedService } from './mysql-embedded.service';

/**
 * Builds the default `MysqlEmbeddedService`: hosts it under `~/.deltix` (or
 * `DELTIX_HOME`), binds the local Dolt SQL server to `127.0.0.1:<port>`, and
 * resolves the Dolt binary through the binary-manager context.
 */
export function createMysqlEmbeddedService(): MysqlEmbeddedService {
  const env = loadEnv();
  return new MysqlEmbeddedService({
    homeDir: env.DELTIX_HOME ?? join(homedir(), '.deltix'),
    localHost: env.DELTIX_LOCAL_HOST,
    localPort: env.DELTIX_LOCAL_PORT,
    binaryManager: new BinaryManager(),
  });
}
