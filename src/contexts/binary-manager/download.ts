/**
 * Downloads official Dolt release tarballs over HTTPS and extracts the single
 * `dolt` executable to the caller's staging directory. This is the only
 * module that holds Dolt's download URL.
 *
 * The gzipped tarball is streamed to a temp file (never shelled out with the
 * URL as an argument, never piped straight into an interpreter), then
 * extracted with the platform `tar` into the staging dir — the same
 * extraction approach the server's `install.sh` uses. We return the isolated
 * `dolt` executable path; nothing else from the archive is ever placed into
 * Deltix's own tree (the downloader is given a throwaway staging dir).
 */
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { extractArchive, findDoltExecutable } from './tar-extract';

export interface DoltDownloader {
  /**
   * Downloads `url` and extracts the `dolt` executable into `destDir`,
   * returning the absolute path of the extracted binary. Throws on any
   * failure (network, HTTP non-200, malformed archive, missing binary).
   */
  download(url: string, destDir: string): Promise<string>;
}

/** Real downloader backed by `fetch` + the platform `tar` binary. */
export function createGitHubReleaseDownloader(): DoltDownloader {
  return {
    async download(url: string, destDir: string): Promise<string> {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Download of Dolt failed: HTTP ${response.status} ${response.statusText}`);
      }
      if (!response.body) {
        throw new Error('Download of Dolt failed: empty response body');
      }

      const isZip = url.endsWith('.zip');
      const archivePath = join(
        tmpdir(),
        `deltix-dolt-${process.pid}-${Math.random().toString(36).slice(2)}.${isZip ? 'zip' : 'tar.gz'}`,
      );
      await mkdir(destDir, { recursive: true });

      try {
        await pipeline(Readable.fromWeb(response.body as never), createWriteStream(archivePath));
        await extractArchive(archivePath, destDir);
        const binary = await findDoltExecutable(destDir);
        if (!binary) {
          throw new Error('Downloaded Dolt archive contained no dolt executable');
        }
        await chmod(binary, 0o755).catch(() => {});
        return binary;
      } finally {
        await rm(archivePath, { force: true }).catch(() => {});
      }
    },
  };
}
