import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BinaryManager,
  type BinaryManagerDeps,
  DOLT_VERSION,
  type DoltDownloader,
  doltReleaseUrl,
} from '../../../src/contexts/binary-manager';

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Fake downloader that materializes a tiny executable without any network. */
function makeFakeDownloader() {
  const state = { calls: 0 };
  const downloader: DoltDownloader = {
    async download(_url: string, destDir: string): Promise<string> {
      state.calls += 1;
      await mkdir(destDir, { recursive: true });
      const path = join(destDir, 'dolt');
      await writeFile(path, '#!/bin/sh\necho fake-dolt\n', { mode: 0o755 });
      return path;
    },
  };
  return { downloader, state };
}

function makeManager(overrides: Partial<BinaryManagerDeps> = {}) {
  return new BinaryManager({ ...overrides });
}

describe('binary-manager/binary-manager.service (unit, fake downloader)', () => {
  it('returns the explicit bin path verbatim, never downloading', async () => {
    const manager = makeManager({ explicitBinPath: '/opt/dolt/bin/dolt' });
    const result = await manager.ensureInstalled();
    expect(result).toBe('/opt/dolt/bin/dolt');
  });

  it('doltReleaseUrl targets github for linux/amd64', () => {
    expect(doltReleaseUrl('2.3.1', 'linux', 'amd64')).toBe(
      'https://github.com/dolthub/dolt/releases/download/v2.3.1/dolt-linux-amd64.tar.gz',
    );
  });

  it('doltReleaseUrl targets darwin/arm64 when asked', () => {
    expect(doltReleaseUrl('2.3.1', 'darwin', 'arm64')).toBe(
      'https://github.com/dolthub/dolt/releases/download/v2.3.1/dolt-darwin-arm64.tar.gz',
    );
  });

  it('installs on first use and then serves the installed copy from cache', async () => {
    const home = await mkdtemp(join(tmpdir(), 'deltix-bm-install-'));
    const { downloader, state } = makeFakeDownloader();
    const manager = makeManager({ homeDir: home, downloader });

    const first = await manager.ensureInstalled();
    expect(first).toBe(join(home, 'bin', `dolt-${DOLT_VERSION}`, 'bin', 'dolt'));
    expect(state.calls).toBe(1);

    // Digest file recorded next to the version dir.
    const digestPath = join(home, 'bin', `dolt-${DOLT_VERSION}`, '.sha256');
    const recorded = (await readFile(digestPath, 'utf8')).trim();
    const expected = sha256(await readFile(first));
    expect(recorded).toBe(expected);

    // Second call must NOT re-download; it reuses the verified installed copy.
    const second = await manager.ensureInstalled();
    expect(second).toBe(first);
    expect(state.calls).toBe(1);

    await rm(home, { recursive: true, force: true });
  });

  it('re-verifies an existing install against its digest and rejects tampering', async () => {
    const home = await mkdtemp(join(tmpdir(), 'deltix-bm-tamper-'));
    const { downloader, state } = makeFakeDownloader();
    const manager = makeManager({ homeDir: home, downloader });

    const installed = await manager.ensureInstalled();
    expect(state.calls).toBe(1);

    // Corrupt the on-disk binary (change bytes) without updating the digest.
    await writeFile(installed, '#!/bin/sh\ntampered\n', { mode: 0o755 });

    // Integrity check fails -> the manager reinstalls rather than trusting it.
    const again = await manager.ensureInstalled();
    expect(again).toBe(installed);
    expect(state.calls).toBe(2);

    await rm(home, { recursive: true, force: true });
  });

  it('versionDir/binaryPath follow the ~/.deltix/bin/dolt-<ver> layout', () => {
    const manager = makeManager({ homeDir: '/x' });
    expect(manager.versionDir('2.3.1')).toBe('/x/bin/dolt-2.3.1');
    expect(manager.binaryPath('2.3.1')).toBe('/x/bin/dolt-2.3.1/bin/dolt');
  });
});
