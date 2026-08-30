import { describe, expect, it } from 'bun:test';
import { parseDsn, redactDsn } from '../../../src/contexts/import/dsn';
import {
  ImportDsnError,
  ImportUnsupportedSchemeError,
} from '../../../src/contexts/import/import-errors';

describe('import/dsn', () => {
  it('parses a mysql DSN with port and database', () => {
    const d = parseDsn('mysql://root:secret@10.1.10.50:3306/legacy');
    expect(d).toEqual({
      scheme: 'mysql',
      host: '10.1.10.50',
      port: 3306,
      user: 'root',
      password: 'secret',
      database: 'legacy',
    });
  });

  it('accepts mariadb and defaults the port to 3306', () => {
    const d = parseDsn('mariadb://app@db.internal/orders');
    expect(d.scheme).toBe('mariadb');
    expect(d.port).toBe(3306);
    expect(d.user).toBe('app');
    expect(d.password).toBe('');
  });

  it('percent-decodes reserved chars in the password', () => {
    const d = parseDsn('mysql://u:p%40ss%2Fw0rd@h:3306/db');
    expect(d.password).toBe('p@ss/w0rd');
  });

  it('rejects a missing database', () => {
    expect(() => parseDsn('mysql://u:p@h:3306/')).toThrow(ImportDsnError);
  });

  it('rejects an unsupported scheme', () => {
    expect(() => parseDsn('postgres://u:p@h/db')).toThrow(ImportUnsupportedSchemeError);
  });

  it('rejects a malformed value', () => {
    expect(() => parseDsn('not a url')).toThrow(ImportDsnError);
  });

  it('redacts the password for logs', () => {
    expect(redactDsn('mysql://root:secret@h:3306/db')).not.toContain('secret');
    expect(redactDsn('mysql://root:secret@h:3306/db')).toContain('***');
    expect(redactDsn('garbage')).toBe('<invalid-dsn>');
  });
});
