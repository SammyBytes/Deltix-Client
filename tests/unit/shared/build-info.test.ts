import { describe, expect, it } from 'bun:test';
import packageJson from '../../../package.json' with { type: 'json' };
import { getClientBuildInfo } from '../../../src/shared/build-info';

describe('getClientBuildInfo', () => {
  it('reports the version from package.json', async () => {
    const info = await getClientBuildInfo();
    expect(info.version).toBe(packageJson.version);
  });

  it('never throws, even if git metadata is unavailable', async () => {
    await expect(getClientBuildInfo()).resolves.toBeTruthy();
  });

  it('resolves a non-empty commit string (env override, git fallback, or "unknown")', async () => {
    const info = await getClientBuildInfo();
    expect(typeof info.commit).toBe('string');
    expect(info.commit.length).toBeGreaterThan(0);
  });
});
