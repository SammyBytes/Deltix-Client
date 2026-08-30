import type { VersioningLocalService } from '../versioning-local';
import { serializeTable } from './csv';
import { type ParsedDsn, parseDsn } from './dsn';
import { ImportBlobError } from './import-errors';
import type { BlobPolicy, ImportOptions, SourceAdapter, TableLoad } from './import-types';
import { topoOrder } from './table-order';

export interface ImportRequest extends ImportOptions {
  /** Raw `mysql://…` / `mariadb://…` connection string. */
  from: string;
}

export interface ImportResult {
  database: string;
  tablesImported: number;
  skipped: { table: string; reason: string }[];
  commitHash: string | null;
}

export interface ImportServiceDeps {
  local: VersioningLocalService;
  makeAdapter: (dsn: ParsedDsn) => SourceAdapter;
}

/**
 * Orchestrates adopting an existing database into the local Dolt (ADR 0001):
 * read a consistent snapshot via a `SourceAdapter`, apply the binary policy,
 * bulk-load tables (parents first), and make an initial commit. Nothing is
 * written to the local repo until every table has been read and validated, so
 * a `--blobs error` abort leaves the working set untouched.
 */
export class ImportService {
  constructor(private readonly deps: ImportServiceDeps) {}

  async import(
    id: { repo: string; projectRoot?: string },
    req: ImportRequest,
  ): Promise<ImportResult> {
    const dsn = parseDsn(req.from);
    const blobs: BlobPolicy = req.blobs ?? 'error';
    const adapter = this.deps.makeAdapter(dsn);
    await adapter.connect();
    try {
      const requested =
        req.tables && req.tables.length > 0 ? req.tables : await adapter.listTables();
      const edges = await adapter.foreignKeyEdges();
      const ordered = topoOrder(requested, edges);

      const loads: TableLoad[] = [];
      const skipped: { table: string; reason: string }[] = [];
      const blobOffenders: { table: string; columns: string[] }[] = [];

      for (const name of ordered) {
        const table = await adapter.readTable(name);
        if (table.binaryColumns.length > 0) {
          if (blobs === 'error') {
            blobOffenders.push({ table: name, columns: table.binaryColumns });
            continue;
          }
          if (blobs === 'skip') {
            skipped.push({
              table: name,
              reason: `binary columns: ${table.binaryColumns.join(', ')}`,
            });
            continue;
          }
        }
        const { csv, base64Columns } = req.schemaOnly
          ? { csv: '', base64Columns: [] }
          : serializeTable(table, blobs);
        loads.push({ name, schema: table.schema, csv, base64Columns });
      }

      // Abort before touching the local repo if any binary was found under `error`.
      if (blobOffenders.length > 0) {
        throw new ImportBlobError(blobOffenders);
      }

      await this.deps.local.bulkImportTables(id, loads);

      let commitHash: string | null = null;
      if (!req.noCommit && loads.length > 0) {
        const stamped = await this.deps.local.commit(
          id,
          `adopt ${dsn.database} @ ${new Date().toISOString()}`,
        );
        commitHash = stamped.commitHash;
      }
      return { database: dsn.database, tablesImported: loads.length, skipped, commitHash };
    } finally {
      await adapter.close();
    }
  }
}
