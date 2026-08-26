import { beforeEach, describe, expect, it } from 'bun:test';
import { __resetEnvCacheForTests, loadEnv } from '../../../src/shared/env';

describe('shared/env', () => {
  beforeEach(() => {
    __resetEnvCacheForTests();
  });

  it('applies sane defaults when no environment variables are set', () => {
    const env = loadEnv({});

    expect(env.NODE_ENV).toBe('development');
  });

  it('rejects an invalid NODE_ENV value', () => {
    expect(() => loadEnv({ NODE_ENV: 'not-a-env' })).toThrow();
  });
});
