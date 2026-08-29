import { describe, expect, it } from 'bun:test';
import { normalizeGrpcHost } from '../../../src/acl/grpc-transfer-client';

describe('acl/grpc-transfer-client normalizeGrpcHost (unit)', () => {
  it('keeps a clean hostname unchanged', () => {
    expect(normalizeGrpcHost('10.1.10.129')).toBe('10.1.10.129');
    expect(normalizeGrpcHost('hbs-svr-pulse')).toBe('hbs-svr-pulse');
  });

  it('strips surrounding whitespace', () => {
    expect(normalizeGrpcHost('  10.1.10.129  ')).toBe('10.1.10.129');
  });

  it('strips embedded newlines that would otherwise break the grpc-js target', () => {
    expect(normalizeGrpcHost('10.1.10.129\n\n')).toBe('10.1.10.129');
    expect(normalizeGrpcHost('10.1.10.129\n\n')).not.toContain('\n');
  });

  it('strips mixed whitespace including carriage returns', () => {
    expect(normalizeGrpcHost('10.1.10.129\r\n')).toBe('10.1.10.129');
  });

  it('normalizes an all-whitespace host to an empty string', () => {
    expect(normalizeGrpcHost('   \n  ')).toBe('');
  });
});
