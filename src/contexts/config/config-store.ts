/**
 * Persists connection settings (server URL, gRPC host/port, TLS trust
 * options) to disk (default: `~/.deltix/config.json`), so a first-time user
 * doesn't have to hand-set env vars to connect to a non-default host —
 * particularly the gRPC TLS options, which previously required knowing
 * about `DELTIX_GRPC_TLS_SERVER_NAME_OVERRIDE` in advance to avoid the
 * `ERR_INVALID_ARG_VALUE` SNI-on-IP-address crash.
 *
 * Values here are only *defaults*: env vars, when explicitly set, always
 * take precedence (see `shared/env.ts`). Never stores secrets — this is
 * connection topology only, not credentials (those live in
 * `contexts/session/credentials-store.ts`).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface StoredConfig {
  serverUrl?: string;
  grpcHost?: string;
  grpcPort?: number;
  grpcTlsCaPath?: string;
  grpcTlsServerNameOverride?: string;
}

export class ConfigStore {
  constructor(private readonly filePath: string) {}

  async save(config: StoredConfig): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(config, null, 2), { mode: 0o600 });
  }

  async load(): Promise<StoredConfig | null> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      return JSON.parse(raw) as StoredConfig;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }
}
