import { beforeEach, describe, expect, it } from 'bun:test';
import { __resetEnvCacheForTests, loadEnv } from '../../../src/shared/env';

describe('shared/env', () => {
  beforeEach(() => {
    __resetEnvCacheForTests();
  });

  it('applies sane defaults when no environment variables are set', () => {
    const env = loadEnv({});

    expect(env.LOG_LEVEL).toBe('info');
    expect(env.LOG_PRETTY).toBe(true);
    expect(env.NODE_ENV).toBe('development');
  });

  it('rejects an invalid LOG_LEVEL value', () => {
    expect(() => loadEnv({ LOG_LEVEL: 'not-a-level' })).toThrow();
  });

  it('coerces LOG_PRETTY from a string env value', () => {
    const env = loadEnv({ LOG_PRETTY: 'false' });
    expect(env.LOG_PRETTY).toBe(false);
  });
});
