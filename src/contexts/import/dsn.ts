import { ImportDsnError, ImportUnsupportedSchemeError } from './import-errors';

export interface ParsedDsn {
  scheme: 'mysql' | 'mariadb';
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

const SUPPORTED = new Set(['mysql', 'mariadb']);

/**
 * Parse a `mysql://user:pass@host:port/database` (or `mariadb://`) DSN.
 * Percent-decodes credentials so passwords with reserved chars work.
 */
export function parseDsn(raw: string): ParsedDsn {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ImportDsnError('Invalid --from value; expected mysql://user:pass@host:port/database');
  }
  const scheme = url.protocol.replace(/:$/, '').toLowerCase();
  if (!SUPPORTED.has(scheme)) {
    throw new ImportUnsupportedSchemeError(scheme || raw);
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!database) {
    throw new ImportDsnError('DSN must include a database name (mysql://.../database)');
  }
  return {
    scheme: scheme as 'mysql' | 'mariadb',
    host: url.hostname || '127.0.0.1',
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
  };
}

/** The DSN with the password masked — safe for logs and error messages. */
export function redactDsn(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.password) {
      url.password = '***';
    }
    return url.toString();
  } catch {
    return '<invalid-dsn>';
  }
}
