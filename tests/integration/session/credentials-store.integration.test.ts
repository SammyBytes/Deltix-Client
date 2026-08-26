import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CredentialsStore } from '../../../src/contexts/session/credentials-store';

describe('session/credentials-store (integration, real filesystem)', () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('saves and reads back credentials from disk', async () => {
    dir = await mkdtemp(join(tmpdir(), 'deltix-creds-'));
    const path = join(dir, 'credentials.json');
    const store = new CredentialsStore(path);

    await store.save({ refreshToken: 'r1', username: 'alice' });
    const loaded = await store.load();

    expect(loaded).toEqual({ refreshToken: 'r1', username: 'alice' });
  });

  it('returns null when no credentials file exists', async () => {
    dir = await mkdtemp(join(tmpdir(), 'deltix-creds-'));
    const store = new CredentialsStore(join(dir, 'missing.json'));

    expect(await store.load()).toBeNull();
  });

  it('writes the credentials file with owner-only permissions (0600)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'deltix-creds-'));
    const path = join(dir, 'credentials.json');
    const store = new CredentialsStore(path);

    await store.save({ refreshToken: 'r1', username: 'alice' });
    const stats = await stat(path);

    expect(stats.mode & 0o777).toBe(0o600);
  });

  it('clear() removes the credentials file', async () => {
    dir = await mkdtemp(join(tmpdir(), 'deltix-creds-'));
    const path = join(dir, 'credentials.json');
    const store = new CredentialsStore(path);

    await store.save({ refreshToken: 'r1', username: 'alice' });
    await store.clear();

    expect(await store.load()).toBeNull();
  });

  it('clear() is a no-op when no credentials file exists', async () => {
    dir = await mkdtemp(join(tmpdir(), 'deltix-creds-'));
    const store = new CredentialsStore(join(dir, 'missing.json'));

    await expect(store.clear()).resolves.toBeUndefined();
  });
});
