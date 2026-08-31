import type { BlobPolicy, SourceTable } from './import-types';

/**
 * Serialize a source table's rows to RFC-4180 CSV for `dolt table import`.
 * The connection is opened with `dateStrings:true`, so dates/timestamps arrive
 * as plain strings and round-trip without timezone skew. SQL NULL -> empty
 * field (which Dolt imports as NULL). Binary cells are handled per `blobs`:
 * only `base64` encodes them (and reports the columns so the loader can run a
 * `FROM_BASE64()` fix-up); `error`/`skip` are enforced by the caller before
 * this runs.
 */
export function serializeTable(
  table: SourceTable,
  blobs: BlobPolicy,
): { csv: string; base64Columns: string[] } {
  const binary = new Set(table.binaryColumns);
  const base64Columns: string[] = [];
  const header = table.columns.map(csvField).join(',');
  const lines = [header];
  for (const row of table.rows) {
    const cells = row.map((value, i) => {
      const col = table.columns[i] ?? '';
      if (value === null || value === undefined) {
        return '';
      }
      if (Buffer.isBuffer(value)) {
        if (blobs === 'base64' && binary.has(col)) {
          if (!base64Columns.includes(col)) {
            base64Columns.push(col);
          }
          return csvField(value.toString('base64'));
        }
        return '';
      }
      // MySQL JSON columns come back from mysql2 as parsed JavaScript
      // objects (not strings), so String(value) would produce the unhelpful
      // '[object Object]'. Round-trip via JSON.stringify so the value lands
      // in Dolt as the same JSON document it had in MySQL.
      if (typeof value === 'object') {
        return csvField(JSON.stringify(value));
      }
      return csvField(String(value));
    });
    lines.push(cells.join(','));
  }
  return { csv: `${lines.join('\n')}\n`, base64Columns };
}

/** Quote a CSV field when it contains a comma, quote, or newline. */
export function csvField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
