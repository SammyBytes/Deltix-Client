import { describe, expect, it } from 'bun:test';
import { parseFlagValue } from '../../../src/cli';

describe('parseFlagValue (cli/index.ts)', () => {
  it('reads --name=value', () => {
    expect(parseFlagValue(['--limit=10', 'repo'], 'limit')).toBe('10');
  });

  it('reads --name value (separate)', () => {
    expect(parseFlagValue(['--limit', '10', 'repo'], 'limit')).toBe('10');
  });

  it('reads -x value (short, single-char)', () => {
    expect(parseFlagValue(['-n', '5', 'repo'], 'n')).toBe('5');
  });

  it('returns undefined when the flag is missing', () => {
    expect(parseFlagValue(['repo'], 'limit')).toBeUndefined();
  });

  it('does not confuse -n with --name', () => {
    // `-n` is one dash, `--name` is two. `-n` should NOT match `--name`.
    expect(parseFlagValue(['-name', 'value'], 'name')).toBeUndefined();
  });

  it('accepts --short=value too (long form parser matches single-dash args too)', () => {
    // Implementation accepts `--n=value` for short flags — convenient, not
    // ambiguous (a single-dash token can't be `--name=value` when flagName
    // is 1 char, since `--n=` ≠ `--name=`).
    expect(parseFlagValue(['--n=5'], 'n')).toBe('5');
  });

  it('handles the flag at any position', () => {
    expect(parseFlagValue(['repo', 'cmd', '--branch', 'main'], 'branch')).toBe('main');
    expect(parseFlagValue(['--branch=main', 'repo', 'cmd'], 'branch')).toBe('main');
    expect(parseFlagValue(['-b', 'main', 'repo', 'cmd'], 'b')).toBe('main');
  });
});
