/**
 * MySQL wire adapter — talks to `dolt sql-server` on :3307 via mysql2.
 * Fast (~50ms), no spawn. Used when local server is running.
 */
import type { DoltSqlPort } from '../ports/dolt-sql.port';
import { TIMEOUT } from '../shared/constants';

export class DoltMysqlAdapter implements DoltSqlPort {
  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly database: string,
  ) {}

  async isAvailable(): Promise<boolean> {
    try {
      const mysql = await import('mysql2/promise');
      const conn = await mysql.createConnection({
        host: this.host,
        port: this.port,
        user: 'root',
        database: this.database,
        connectTimeout: TIMEOUT.MYSQL_CONNECT_FAST,
      });
      await conn.query('SELECT 1');
      await conn.end();
      return true;
    } catch {
      return false;
    }
  }

  async query<T extends Record<string, unknown>>(sql: string): Promise<T[]> {
    const mysql = await import('mysql2/promise');
    const conn = await mysql.createConnection({
      host: this.host,
      port: this.port,
      user: 'root',
      database: this.database,
      connectTimeout: TIMEOUT.MYSQL_CONNECT_SLOW,
    });
    try {
      const [rows] = await conn.query(sql);
      return rows as T[];
    } finally {
      await conn.end().catch(() => {});
    }
  }

  async exec(sql: string): Promise<void> {
    const mysql = await import('mysql2/promise');
    const conn = await mysql.createConnection({
      host: this.host,
      port: this.port,
      user: 'root',
      database: this.database,
      connectTimeout: TIMEOUT.MYSQL_CONNECT_SLOW,
    });
    try {
      await conn.query(sql);
    } finally {
      await conn.end().catch(() => {});
    }
  }

  async call(proc: string, args: string[]): Promise<unknown> {
    const esc = (s: string) => `'${s.replace(/'/g, "''")}'`;
    const sql = `CALL ${proc}(${args.map(esc).join(', ')})`;
    const rows = await this.query<Record<string, unknown>>(sql);
    return rows;
  }
}
