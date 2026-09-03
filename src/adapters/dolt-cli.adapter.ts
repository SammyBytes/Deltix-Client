/**
 * Adapter CLI — habla a `dolt` binario vía `runDoltCommand`.
 * Lento (~3s/spawn) pero funciona aunque el sql-server esté apagado.
 * Fallback del `DoltMysqlAdapter`.
 */
import { runDoltCommand } from '../acl/dolt-exec';
import type { DoltSqlPort } from '../ports/dolt-sql.port';

export class DoltCliAdapter implements DoltSqlPort {
  constructor(
    private readonly binaryPath: string,
    private readonly dataDir: string,
  ) {}

  async isAvailable(): Promise<boolean> {
    return true; // CLI siempre disponible si el binario existe
  }

  async query<T extends Record<string, unknown>>(sql: string): Promise<T[]> {
    const result = await runDoltCommand(
      this.binaryPath,
      ['--data-dir', this.dataDir, 'sql', '-q', sql, '-r', 'json'],
      { timeoutMs: 15_000 },
    );
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || result.stdout.trim());
    const trimmed = result.stdout.trim();
    if (!trimmed) return [];
    return (JSON.parse(trimmed) as { rows?: T[] }).rows ?? [];
  }

  async exec(sql: string): Promise<void> {
    const result = await runDoltCommand(
      this.binaryPath,
      ['--data-dir', this.dataDir, 'sql', '-q', sql],
      { timeoutMs: 10_000 },
    );
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || result.stdout.trim());
  }

  async call(proc: string, args: string[]): Promise<unknown> {
    const esc = (s: string) => s.replace(/'/g, "''");
    const sql = `CALL ${proc}(${args.map((a) => `'${esc(a)}'`).join(', ')})`;
    return this.query(sql);
  }
}
