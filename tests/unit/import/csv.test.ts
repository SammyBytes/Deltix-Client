import { describe, expect, it } from 'bun:test';
import { csvField, serializeTable } from '../../../src/contexts/import/csv';
import type { SourceTable } from '../../../src/contexts/import/import-types';

function table(overrides: Partial<SourceTable> = {}): SourceTable {
  return {
    name: 't',
    schema: 'CREATE TABLE t (id INT PRIMARY KEY, name VARCHAR(50));',
    columns: ['id', 'name'],
    binaryColumns: [],
    rows: [
      [1, 'Ana'],
      [2, null],
    ],
    ...overrides,
  };
}

describe('import/csv', () => {
  it('quotes fields with commas and escapes embedded quotes (RFC-4180)', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
  });

  it('serializes rows with NULL as an empty field', () => {
    const { csv, base64Columns } = serializeTable(table(), 'error');
    expect(csv).toBe('id,name\n1,Ana\n2,\n');
    expect(base64Columns).toEqual([]);
  });

  it('base64-encodes binary cells only under the base64 policy', () => {
    const withBlob: SourceTable = {
      ...table({ columns: ['id', 'blob'], binaryColumns: ['blob'] }),
      rows: [[1, Buffer.from('hi')]],
    };
    const encoded = serializeTable(withBlob, 'base64');
    expect(encoded.base64Columns).toEqual(['blob']);
    expect(encoded.csv).toContain(Buffer.from('hi').toString('base64'));

    const dropped = serializeTable(withBlob, 'error');
    expect(dropped.csv).toBe('id,blob\n1,\n'); // error mode is aborted upstream; never crashes
  });
});
