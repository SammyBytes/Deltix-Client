/** Validador puro — alta cohesión, 0 I/O */
export const SAFE_TABLE_RE = /^[A-Za-z_][A-Za-z0-9_]*$/ as const;

export function assertSafeTable(name: string): void {
  if (!SAFE_TABLE_RE.test(name)) throw new Error(`invalid table name "${name}"`);
}

export function sanitizeAuthor(name: string): string {
  return (name ?? 'deltix').replace(/[^A-Za-z0-9_.-]/g, '_');
}

export function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}
