import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __resetHttpTlsCacheForTests, buildFetchTlsOptions } from '../../../src/shared/http-tls';

describe('shared/http-tls', () => {
  let dir: string;
  let caPath: string;
  const CA_PEM = '-----BEGIN CERTIFICATE-----\nfake-cert-contents\n-----END CERTIFICATE-----\n';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'deltix-http-tls-'));
    caPath = join(dir, 'ca.crt');
    await writeFile(caPath, CA_PEM, 'utf8');
    __resetHttpTlsCacheForTests();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns undefined when no CA path is configured (no override needed)', () => {
    expect(buildFetchTlsOptions({})).toBeUndefined();
  });

  it('reads and returns the CA cert contents when a path is configured', () => {
    const result = buildFetchTlsOptions({ caCertPath: caPath });
    expect(result).toEqual({ ca: CA_PEM });
  });

  it('includes serverName when a server name override is configured', () => {
    const result = buildFetchTlsOptions({ caCertPath: caPath, serverNameOverride: 'localhost' });
    expect(result).toEqual({ ca: CA_PEM, serverName: 'localhost' });
  });

  it('caches file reads across calls with the same path', async () => {
    const first = buildFetchTlsOptions({ caCertPath: caPath });
    // Mutate the file on disk after the first read.
    await writeFile(caPath, 'different-contents', 'utf8');
    const second = buildFetchTlsOptions({ caCertPath: caPath });
    expect(first).toEqual(second);
  });

  it('re-reads the file after the cache is reset', async () => {
    buildFetchTlsOptions({ caCertPath: caPath });
    await writeFile(caPath, 'different-contents', 'utf8');
    __resetHttpTlsCacheForTests();
    const result = buildFetchTlsOptions({ caCertPath: caPath });
    expect(result).toEqual({ ca: 'different-contents' });
  });

  it('throws if the configured CA path does not exist', () => {
    expect(() => buildFetchTlsOptions({ caCertPath: join(dir, 'missing.crt') })).toThrow();
  });
});
