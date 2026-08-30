import mysql from 'mysql2/promise';
import type { ParsedDsn } from './dsn';
import { ImportError } from './import-errors';
import type { SourceAdapter, SourceTable } from './import-types';

const BINARY_TYPES = new Set([
  'blob',
  'tinyblob',
  'mediumblob',
  'longblob',
  'binary',
  'varbinary',
  'geometry',
  'point',
  'linestring',
  'polygon',
]);

/** Quote a MySQL identifier (backticks, escaping embedded backticks). */
function q(ident: string): string {
  return `\`${ident.replace(/`/g, '``')}\``;
}

/**
 * MySQL/MariaDB `SourceAdapter`. Opens a single read-only connection and holds
 * one REPEATABLE READ transaction with a consistent snapshot for the whole
 * import, so every table reflects the same point in time.
 */
export class MysqlAdapter implements SourceAdapter {
  private conn: mysql.Connection | null = null;

  constructor(private readonly dsn: ParsedDsn) {}

  async connect(): Promise<void> {
    this.conn = await mysql.createConnection({
      host: this.dsn.host,
      port: this.dsn.port,
      user: this.dsn.user,
      password: this.dsn.password,
      database: this.dsn.database,
      dateStrings: true, // dates/timestamps come back as strings (no tz skew)
      supportBigNumbers: true,
      bigNumberStrings: true,
    });
    await this.conn.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await this.conn.query('START TRANSACTION WITH CONSISTENT SNAPSHOT');
  }

  private db(): mysql.Connection {
    if (!this.conn) {
      throw new ImportError('(connection)', 'adapter used before connect()');
    }
    return this.conn;
  }

  async listTables(): Promise<string[]> {
    const [rows] = await this.db().query<mysql.RowDataPacket[]>(
      'SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = ?',
      [this.dsn.database, 'BASE TABLE'],
    );
    return rows.map((r) => String(r.name));
  }

  async foreignKeyEdges(): Promise<{ child: string; parent: string }[]> {
    const [rows] = await this.db().query<mysql.RowDataPacket[]>(
      `SELECT TABLE_NAME AS child, REFERENCED_TABLE_NAME AS parent
         FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL`,
      [this.dsn.database],
    );
    return rows.map((r) => ({ child: String(r.child), parent: String(r.parent) }));
  }

  async readTable(name: string): Promise<SourceTable> {
    const conn = this.db();
    const [createRows] = await conn.query<mysql.RowDataPacket[]>(`SHOW CREATE TABLE ${q(name)}`);
    const schema = String((createRows[0] as Record<string, unknown>)['Create Table'] ?? '');

    const [colRows] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT COLUMN_NAME AS name, DATA_TYPE AS type
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        ORDER BY ORDINAL_POSITION`,
      [this.dsn.database, name],
    );
    const columns = colRows.map((r) => String(r.name));
    const binaryColumns = colRows
      .filter((r) => BINARY_TYPES.has(String(r.type).toLowerCase()))
      .map((r) => String(r.name));

    const [rows] = await conn.query<mysql.RowDataPacket[]>(`SELECT * FROM ${q(name)}`);
    const tableRows = (rows as mysql.RowDataPacket[]).map((row) =>
      columns.map((c) => (row as Record<string, unknown>)[c] ?? null),
    );

    return { name, schema, columns, binaryColumns, rows: tableRows };
  }

  async close(): Promise<void> {
    if (this.conn) {
      await this.conn.end().catch(() => {});
      this.conn = null;
    }
  }
}
