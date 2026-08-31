import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  __resetEnvCacheForTests,
  applyPersistedConfigDefaults,
  loadEnv,
} from '../../../src/shared/env';

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

  describe('applyPersistedConfigDefaults', () => {
    const savedEnv: Record<string, string | undefined> = {};

    beforeEach(() => {
      for (const key of [
        'DELTIX_SERVER_URL',
        'DELTIX_GRPC_HOST',
        'DELTIX_GRPC_PORT',
        'DELTIX_GRPC_TLS_CA_PATH',
        'DELTIX_GRPC_TLS_SERVER_NAME_OVERRIDE',
      ]) {
        savedEnv[key] = Bun.env[key];
        delete Bun.env[key];
      }
    });

    afterEach(() => {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete Bun.env[key];
        else Bun.env[key] = value;
      }
    });

    it('fills Bun.env from persisted config when unset', () => {
      applyPersistedConfigDefaults({
        serverUrl: 'https://10.1.10.129:9090',
        httpTlsCaPath: '/etc/deltix/server.crt',
        httpTlsServerNameOverride: 'hbs-svr-pulse',
        localHost: '127.0.0.1',
        localPort: 3307,
      });

      expect(Bun.env.DELTIX_SERVER_URL).toBe('https://10.1.10.129:9090');
      expect(Bun.env.DELTIX_HTTP_TLS_CA_PATH).toBe('/etc/deltix/server.crt');
      expect(Bun.env.DELTIX_HTTP_TLS_SERVER_NAME_OVERRIDE).toBe('hbs-svr-pulse');
      expect(Bun.env.DELTIX_LOCAL_HOST).toBe('127.0.0.1');
      expect(Bun.env.DELTIX_LOCAL_PORT).toBe('3307');
    });

    it('never overrides an already-set env var (env vars always win)', () => {
      Bun.env.DELTIX_LOCAL_PORT = '3307';

      applyPersistedConfigDefaults({ localPort: 9999 });

      expect(Bun.env.DELTIX_LOCAL_PORT).toBe('3307');
    });
  });
});
