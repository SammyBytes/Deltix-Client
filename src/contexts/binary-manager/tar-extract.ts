/**
 * Extracts Dolt release gzip tarballs and locates the `dolt` executable.
 *
 * Extraction delegates to the platform `tar` (present on every supported
 * platform, exactly as the Deltix-Server `install.sh` does) rather than
 * parsing the POSIX tar format by hand — the client trusts the tar tool to
 * expand the official archive and only ever materializes the single `dolt`
 * binary, which the binary-manager hashes and re-verifies before every run.
 */
import { existsSync } from 'node:fs';
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { runCommand, whichBinary } from '../../acl/dolt-exec';

/**
 * Extracts the gzip'd tarball at `tarballPath` into `destDir` using the
 * platform `tar`. Throws when tar is unavailable or the extraction fails.
 */
export async function extractTarGz(tarballPath: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });
  const tar = await whichBinary('tar');
  if (!tar) {
    throw new Error('No `tar` binary available to extract the Dolt archive');
  }
  const result = await runCommand(tar, ['-xzf', tarballPath, '-C', destDir]);
  if (result.exitCode !== 0) {
    throw new Error(`Failed to extract Dolt tarball: ${result.stderr.trim() || 'tar error'}`);
  }
}

/** Walks `root` and returns the path of a `dolt` executable if found. */
export async function findDoltExecutable(root: string): Promise<string | null> {
  // Common layout of official release tarballs: `dolt/bin/dolt` (darwin) or
  // `dolt-linux-amd64/bin/dolt`. Prefer well-known paths, then fall back to
  // a recursive scan so we stay robust to future layout changes.
  const expected = [
    join(root, 'dolt', 'bin', 'dolt'),
    join(
      root,
      `dolt-${process.platform === 'darwin' ? 'darwin' : 'linux'}${archSuffix()}`,
      'bin',
      'dolt',
    ),
  ];
  for (const candidate of expected) {
    if (existsSync(candidate)) return candidate;
  }
  return (await scanForDolt(root)) ?? null;
}

function archSuffix(): string {
  return process.arch === 'arm64' ? '-arm64' : '-amd64';
}

async function scanForDolt(dir: string): Promise<string | null> {
  let entries: Awaited<ReturnType<typeof readdir>> | undefined;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = await scanForDolt(full);
      if (found) return found;
    } else if (entry.isFile() && entry.name === 'dolt') {
      return full;
    }
  }
  return null;
}
