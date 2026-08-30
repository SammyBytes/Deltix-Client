import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadEnv } from '../../shared/env';
import { BinaryManager } from '../binary-manager';
import { VersioningLocalService } from '../versioning-local';
import { ImportService } from './import.service';
import { MysqlAdapter } from './mysql-adapter';

/** Wire the import context: local Dolt writer + MySQL/MariaDB source adapter. */
export function createImportService(): ImportService {
  const homeDir = loadEnv().DELTIX_HOME ?? join(homedir(), '.deltix');
  const local = new VersioningLocalService({
    homeDir,
    binaryManager: new BinaryManager(),
  });
  return new ImportService({
    local,
    makeAdapter: (dsn) => new MysqlAdapter(dsn),
  });
}
