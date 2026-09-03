/**
 * Adapter MySQL wire — habla a `dolt sql-server` en :3307 vía mysql2.
 * Rápido (~50ms), no spawnea procesos. Usado cuando el server local está vivo.
 */
import type { DoltSqlPort } from '../ports/dolt-sql.port';

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
        connectTimeout: 800,
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
      connectTimeout: 1500,
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
      connectTimeout: 1500,
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
