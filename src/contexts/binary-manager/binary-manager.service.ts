/**
 * The "binary-manager" bounded context.
 *
 * Conservative, black-box management of the local `dolt` CLI binary used by
 * the other local contexts (mysql-embedded's `dolt sql-server`, versioning's
 * `dolt commit`/`dolt push`). Dolt is installed as an unmodified official
 * release artifact only — never compiled, patched, or otherwise altered
 * locally — and its on-disk integrity is re-verified before every use.
 *
 * Resolution order when the CLI needs a dolt binary:
 *   1. `DELTIX_DOLT_BIN_PATH` (explicit override; trusted as-is for
 *      CI/preinstalled setups).
 *   2. A `dolt` on `PATH` reporting the pinned version.
 *   3. An already-installed copy under `~/.deltix/bin/dolt-<ver>` re-verified
 *      against its recorded SHA-256.
 *   4. Otherwise: download the official release tarball over HTTPS, extract
 *      it, record its SHA-256 for future re-verification (trust-on-first-use,
 *      the same model `configure` uses for the server certificate).
 *
 * No version other than the pinned `DOLT_VERSION` is ever selected, so the
 * client and the server always speak the same Dolt on-disk format.
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand, whichBinary } from '../../acl/dolt-exec';
import { loadEnv } from '../../shared/env';
import { createGitHubReleaseDownloader, type DoltDownloader } from './download';

export const DOLT_VERSION = '2.3.1';

/** Host OSes with an official Dolt release we know how to fetch. */
type DoltOs = 'darwin' | 'linux' | 'win32';

export interface BinaryManagerDeps {
  /** Root state dir; defaults to `~/.deltix` (or `DELTIX_HOME`). */
  homeDir?: string;
  /** Overrides `DELTIX_DOLT_BIN_PATH` (and the env var). */
  explicitBinPath?: string;
  /** Overrides OS auto-detection (test/CI). */
  os?: DoltOs;
  /** Overrides arch auto-detection (test/CI). */
  arch?: 'arm64' | 'amd64';
  downloader?: DoltDownloader;
}

export class BinaryManager {
  private readonly homeDir: string;
  private cachedPath: string | null = null;

  constructor(private readonly deps: BinaryManagerDeps = {}) {
    const env = loadEnv();
    this.homeDir = deps.homeDir ?? env.DELTIX_HOME ?? defaultHomeDir();
  }

  /**
   * Locates (installing if necessary) a usable dolt binary and returns its
   * absolute path. Safe to call repeatedly — resolution is cheap once a
   * binary is installed, and download happens at most once per version.
   */
  async ensureInstalled(): Promise<string> {
    const explicit = this.deps.explicitBinPath;
    if (explicit !== undefined) return explicit;

    const env = loadEnv();
    if (env.DELTIX_DOLT_BIN_PATH) return env.DELTIX_DOLT_BIN_PATH;

    // Cache the PATH lookup (spawns `which` + `dolt --version`, ~100ms)
    // but not the installed-binary digest check — that must re-verify the
    // on-disk file every call so tampering is detected.
    if (this.cachedPath) {
      if (existsSync(this.cachedPath)) return this.cachedPath;
      this.cachedPath = null;
    }

    const onPath = await findOnPath(env.DELTIX_DOLT_VERSION);
    if (onPath !== null) {
      this.cachedPath = onPath;
      return onPath;
    }

    const installed = await this.findInstalled(env.DELTIX_DOLT_VERSION);
    if (installed !== null) return installed;

    return this.install(env.DELTIX_DOLT_VERSION);
  }

  /** Convenience alias used by consumers that spawn `dolt` (e.g. sql-server). */
  async getDoltBinary(): Promise<string> {
    return this.ensureInstalled();
  }

  /** Absolute path to the versioned binary dir: `~/.deltix/bin/dolt-<ver>`. */
  versionDir(version: string): string {
    return join(this.homeDir, 'bin', `dolt-${version}`);
  }

  /** Absolute path to the install'd dolt executable for a version. */
  binaryPath(version: string): string {
    const exe = process.platform === 'win32' ? 'dolt.exe' : 'dolt';
    return join(this.versionDir(version), 'bin', exe);
  }

  /** Returns the installed binary path if present and digest-verified. */
  private async findInstalled(version: string): Promise<string | null> {
    const path = this.binaryPath(version);
    if (!existsSync(path)) return null;
    const digestPath = join(this.versionDir(version), '.sha256');
    if (!existsSync(digestPath)) return null;
    try {
      const actual = await sha256File(path);
      const expected = (await readFile(digestPath, 'utf8')).trim();
      if (actual === expected) return path;
    } catch {
      // Fall through and (re)install below on any read/failure.
    }
    return null;
  }

  /** Installs the pinned version: download -> extract -> hash -> record. */
  private async install(version: string): Promise<string> {
    const downloader = this.deps.downloader ?? createGitHubReleaseDownloader();
    const os = this.deps.os ?? defaultOs();
    const arch = this.deps.arch ?? defaultArch();
    const url = doltReleaseUrl(version, os, arch);

    const binDir = join(this.versionDir(version), 'bin');
    await mkdir(binDir, { recursive: true });

    // Stage in a temp dir, then atomically place the binary + digest so a
    // failure mid-install never leaves a half-written, half-trusted binary.
    const stageDir = join(
      tmpdir(),
      `deltix-dolt-install-${process.pid}-${Math.random().toString(36).slice(2)}`,
    );
    try {
      const stagedBin = await downloader.download(url, stageDir);
      const exe = process.platform === 'win32' ? 'dolt.exe' : 'dolt';
      const dest = join(binDir, exe);
      const tmpDest = join(binDir, `.dolt.tmp-${Math.random().toString(36).slice(2)}`);
      await copyFile(stagedBin, tmpDest);
      try {
        await chmod(tmpDest, 0o755).catch(() => {});
        await rename(tmpDest, dest);
      } catch (err) {
        await rm(tmpDest, { force: true });
        throw err;
      }

      const digest = await sha256File(dest);
      await writeFile(join(this.versionDir(version), '.sha256'), digest, { mode: 0o600 });
      return dest;
    } finally {
      await rm(stageDir, { recursive: true, force: true });
    }
  }
}

function defaultOs(): DoltOs {
  if (process.platform === 'darwin') return 'darwin';
  if (process.platform === 'win32') return 'win32';
  return 'linux';
}

function defaultArch(): 'arm64' | 'amd64' {
  return process.arch === 'arm64' ? 'arm64' : 'amd64';
}

export function defaultHomeDir(): string {
  // Use os.homedir() — on Windows `process.env.HOME` is typically undefined
  // (the platform uses USERPROFILE), which previously produced a *relative*
  // `.deltix/...` path and made the resolved binary unfindable.
  return join(homedir(), '.deltix');
}

async function findOnPath(version: string): Promise<string | null> {
  const cmd = await whichBinary('dolt');
  if (!cmd) return null;
  const result = await runCommand(cmd, ['--version']);
  if (result.exitCode !== 0) return null;
  if (!versionMatches(result.stdout, version)) return null;
  return cmd;
}

function versionMatches(output: string, expected: string): boolean {
  const m = /Dolt\s+(\S+)/i.exec(output);
  if (!m) return false;
  return m[1] === expected || m[1].startsWith(`${expected}-`) || m[1] === `v${expected}`;
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (c: Buffer) => hash.update(c));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export function doltReleaseUrl(version: string, os: string, arch: string): string {
  const a = arch === 'arm64' ? 'arm64' : 'amd64';
  if (os === 'win32') {
    return `https://github.com/dolthub/dolt/releases/download/v${version}/dolt-windows-${a}.zip`;
  }
  const platform = os === 'darwin' ? 'darwin' : 'linux';
  return `https://github.com/dolthub/dolt/releases/download/v${version}/dolt-${platform}-${a}.tar.gz`;
}
