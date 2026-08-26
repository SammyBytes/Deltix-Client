/**
 * Persists the session refresh token + username to disk (default:
 * `~/.deltix/credentials.json`), restricted to owner-only read/write (0600).
 * Never stores the license key or any server-side secret — only the
 * client's own opaque refresh token, per copilot-instructions.md §1/§5.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface StoredCredentials {
  refreshToken: string;
  username: string;
}

export class CredentialsStore {
  constructor(private readonly filePath: string) {}

  async save(credentials: StoredCredentials): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(credentials), { mode: 0o600 });
  }

  async load(): Promise<StoredCredentials | null> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      return JSON.parse(raw) as StoredCredentials;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async clear(): Promise<void> {
    await rm(this.filePath, { force: true });
  }
}
