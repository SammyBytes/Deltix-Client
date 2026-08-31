import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { persistLocalPortIfExplicit } from '../../../src/cli';

describe('persistLocalPortIfExplicit (cli/index.ts)', () => {
  let home: string | undefined;

  afterEach(async () => {
    delete Bun.env.DELTIX_LOCAL_PORT;
    if (home) {
      await rm(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  function configPath(): string {
    if (!home) throw new Error('test bug: home not set');
    return join(home, '.deltix', 'config.json');
  }

  it('does nothing when DELTIX_LOCAL_PORT is unset (operator used the default)', async () => {
    home = await mkdtemp(join(tmpdir(), 'deltix-cli-port-default-'));
    delete Bun.env.DELTIX_LOCAL_PORT;
    await persistLocalPortIfExplicit(3306, configPath());
    const file = Bun.file(configPath());
    expect(await file.exists()).toBe(false);
  });

  it('persists the port into the config when DELTIX_LOCAL_PORT is explicit', async () => {
    home = await mkdtemp(join(tmpdir(), 'deltix-cli-port-explicit-'));
    Bun.env.DELTIX_LOCAL_PORT = '3307';
    await persistLocalPortIfExplicit(3307, configPath());
    const raw = await readFile(configPath(), 'utf8');
    expect(JSON.parse(raw)).toEqual({ localPort: 3307 });
  });

  it('merges with existing config (does not clobber serverUrl, TLS, etc.)', async () => {
    home = await mkdtemp(join(tmpdir(), 'deltix-cli-port-merge-'));
    Bun.env.DELTIX_LOCAL_PORT = '3307';
    await Bun.write(
      configPath(),
      JSON.stringify({ serverUrl: 'http://127.0.0.1:9090', grpcTlsCaPath: '/tmp/ca.crt' }),
    );
    await persistLocalPortIfExplicit(3307, configPath());
    const raw = await readFile(configPath(), 'utf8');
    expect(JSON.parse(raw)).toEqual({
      serverUrl: 'http://127.0.0.1:9090',
      grpcTlsCaPath: '/tmp/ca.crt',
      localPort: 3307,
    });
  });

  it('rewrites the port when the operator runs `start` with a different explicit port', async () => {
    home = await mkdtemp(join(tmpdir(), 'deltix-cli-port-rewrite-'));
    Bun.env.DELTIX_LOCAL_PORT = '3400';
    await persistLocalPortIfExplicit(3400, configPath());
    const raw1 = await readFile(configPath(), 'utf8');
    expect(JSON.parse(raw1).localPort).toBe(3400);
    Bun.env.DELTIX_LOCAL_PORT = '3500';
    await persistLocalPortIfExplicit(3500, configPath());
    const raw2 = await readFile(configPath(), 'utf8');
    expect(JSON.parse(raw2).localPort).toBe(3500);
  });
});
