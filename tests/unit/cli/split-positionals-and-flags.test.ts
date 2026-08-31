import { describe, expect, it } from 'bun:test';
import { splitPositionalsAndFlags } from '../../../src/cli';

describe('splitPositionalsAndFlags', () => {
  it('separates -n value (single-dash, space-separated) from positionals', () => {
    expect(splitPositionalsAndFlags(['-n', '5', 'hmc-sync'])).toEqual({
      positionals: ['hmc-sync'],
      flags: ['-n', '5'],
    });
  });

  it('separates --limit=N (double-dash, equals-separated) from positionals', () => {
    expect(splitPositionalsAndFlags(['--limit=5', 'hmc-sync'])).toEqual({
      positionals: ['hmc-sync'],
      flags: ['--limit=5'],
    });
  });

  it('works when flags come after positionals', () => {
    expect(splitPositionalsAndFlags(['hmc-sync', '-n', '5'])).toEqual({
      positionals: ['hmc-sync'],
      flags: ['-n', '5'],
    });
  });

  it('handles mixed flags and positionals', () => {
    expect(splitPositionalsAndFlags(['hmc-sync', '--branch=main', '-n', '10'])).toEqual({
      positionals: ['hmc-sync'],
      flags: ['--branch=main', '-n', '10'],
    });
  });

  it('handles empty args', () => {
    expect(splitPositionalsAndFlags([])).toEqual({
      positionals: [],
      flags: [],
    });
  });

  it('handles no flags', () => {
    expect(splitPositionalsAndFlags(['hmc-sync'])).toEqual({
      positionals: ['hmc-sync'],
      flags: [],
    });
  });

  it('handles no positionals', () => {
    expect(splitPositionalsAndFlags(['-n', '5'])).toEqual({
      positionals: [],
      flags: ['-n', '5'],
    });
  });

  it('does not consume a negative number as a flag value', () => {
    expect(splitPositionalsAndFlags(['repo', '-n', '-3'])).toEqual({
      positionals: ['repo'],
      flags: ['-n', '-3'],
    });
  });
});
