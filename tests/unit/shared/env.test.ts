import { beforeEach, describe, expect, it } from 'bun:test';
import { __resetEnvCacheForTests, loadEnv } from '../../../src/shared/env';

describe('shared/env', () => {
  beforeEach(() => {
    __resetEnvCacheForTests();
  });

  it('applies sane defaults when no environment variables are set', () => {
    const env = loadEnv({});

    expect(env.NODE_ENV).toBe('development');
    expect(env.DELTIX_SERVER_URL).toBe('http://127.0.0.1:9090');
    expect(env.DELTIX_CREDENTIALS_PATH).toBeUndefined();
  });

  it('rejects an invalid NODE_ENV value', () => {
    expect(() => loadEnv({ NODE_ENV: 'not-a-env' })).toThrow();
  });

  it('rejects a malformed DELTIX_SERVER_URL', () => {
    expect(() => loadEnv({ DELTIX_SERVER_URL: 'not-a-url' })).toThrow();
  });

  it('accepts a custom DELTIX_SERVER_URL and DELTIX_CREDENTIALS_PATH', () => {
    const env = loadEnv({
      DELTIX_SERVER_URL: 'https://deltix.example.com',
      DELTIX_CREDENTIALS_PATH: '/tmp/creds.json',
    });

    expect(env.DELTIX_SERVER_URL).toBe('https://deltix.example.com');
    expect(env.DELTIX_CREDENTIALS_PATH).toBe('/tmp/creds.json');
  });
});
