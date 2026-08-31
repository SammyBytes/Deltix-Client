/**
 * Persists connection settings (server URL, TLS trust options, local Dolt
 * bind) to disk (default: `~/.deltix/config.json`), so a first-time user
 * doesn't have to hand-set env vars to connect to a non-default host —
 * particularly the TLS options, which previously required knowing about
 * `DELTIX_HTTP_TLS_SERVER_NAME_OVERRIDE` in advance to avoid the
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
  /** REST URL of Deltix-Server (e.g. http://server:9090 or https://). */
  serverUrl?: string;
  /** CA to trust the server's HTTPS certificate against. */
  httpTlsCaPath?: string;
  /** SNI ServerName when connecting to the server by bare IP address. */
  httpTlsServerNameOverride?: string;
  /**
   * Bind address for the local `dolt sql-server` (the mysql-embedded
   * context). Defaults to 127.0.0.1; persisted via `deltix configure`.
   */
  localHost?: string;
  /**
   * Port the local `dolt sql-server` binds to when `deltix start` launches
   * it. Defaults to 3306; persisted via `deltix configure` so a host
   * with a pre-installed MySQL on 3306 can pick a free port without
   * exporting env vars by hand.
   */
  localPort?: number;
  /**
   * Absolute path to a pre-installed Dolt binary to use instead of the one
   * the binary-manager downloads. Optional; maps to `DELTIX_DOLT_BIN_PATH`
   * (see `shared/env.ts#applyPersistedConfigDefaults`).
   */
  localDoltBinPath?: string;
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
