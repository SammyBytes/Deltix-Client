import { afterEach, describe, expect, it } from 'bun:test';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore } from '../../../src/contexts/config/config-store';

const testPath = join(tmpdir(), `deltix-config-store-test-${Date.now()}.json`);

describe('config/ConfigStore (unit, real filesystem)', () => {
  afterEach(async () => {
    await rm(testPath, { force: true });
  });

  it('returns null when no config file exists yet', async () => {
    const store = new ConfigStore(testPath);

    expect(await store.load()).toBeNull();
  });

  it('persists and reads back a config round-trip', async () => {
    const store = new ConfigStore(testPath);
    const config = {
      serverUrl: 'https://10.1.10.129:9090',
      grpcHost: '10.1.10.129',
      grpcPort: 50051,
      grpcTlsServerNameOverride: 'localhost',
    };

    await store.save(config);

    expect(await store.load()).toEqual(config);
  });

  it('creates parent directories that do not exist yet', async () => {
    const nestedPath = join(tmpdir(), `deltix-config-nested-${Date.now()}`, 'config.json');
    const store = new ConfigStore(nestedPath);

    await store.save({ serverUrl: 'http://127.0.0.1:9090' });

    expect(await store.load()).toEqual({ serverUrl: 'http://127.0.0.1:9090' });
    await rm(join(tmpdir(), `deltix-config-nested-${Date.now()}`), {
      recursive: true,
      force: true,
    });
  });
});
