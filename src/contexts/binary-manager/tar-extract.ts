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
 * Extracts the Dolt release archive (`.tar.gz` on unix, `.zip` on Windows)
 * into `destDir` using the platform `tar`. `-xf` lets the tool auto-detect the
 * format: GNU tar handles the gzip tarball on Linux/macOS; the bsdtar shipped
 * with Windows 10+ also expands the `.zip`. Throws when tar is missing or
 * extraction fails.
 */
export async function extractArchive(archivePath: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });
  const tar = await whichBinary('tar');
  if (!tar) {
    throw new Error('No `tar` binary available to extract the Dolt archive');
  }
  const result = await runCommand(tar, ['-xf', archivePath, '-C', destDir]);
  if (result.exitCode !== 0) {
    throw new Error(`Failed to extract Dolt archive: ${result.stderr.trim() || 'tar error'}`);
  }
}

/** Walks `root` and returns the path of a `dolt` executable if found. */
export async function findDoltExecutable(root: string): Promise<string | null> {
  const exe = process.platform === 'win32' ? 'dolt.exe' : 'dolt';
  const dirName = archiveDirName();
  // Common layouts: `dolt/bin/dolt`, `dolt-<os>-<arch>/bin/dolt`, and the
  // Windows zip's `dolt-windows-amd64\bin\dolt.exe`. Prefer known paths, then
  // fall back to a recursive scan so we stay robust to layout changes.
  const expected = [join(root, 'dolt', 'bin', exe), join(root, dirName, 'bin', exe)];
  for (const candidate of expected) {
    if (existsSync(candidate)) return candidate;
  }
  return (await scanForDolt(root, exe)) ?? null;
}

function archiveDirName(): string {
  const os =
    process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'windows' : 'linux';
  return `dolt-${os}${process.arch === 'arm64' ? '-arm64' : '-amd64'}`;
}

async function scanForDolt(dir: string, exe: string): Promise<string | null> {
  let entries: Awaited<ReturnType<typeof readdir>> | undefined;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = await scanForDolt(full, exe);
      if (found) return found;
    } else if (entry.isFile() && entry.name === exe) {
      return full;
    }
  }
  return null;
}
