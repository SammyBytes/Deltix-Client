/**
 * Centralized, validated access to environment variables.
 *
 * Every env var the CLI depends on is declared and validated here with zod.
 * Fails fast and loudly if a required variable is missing or malformed.
 * This schema will grow in later phases (session/auth, binary manager, etc.)
 * — add new variables here, never read `Bun.env` ad-hoc elsewhere.
 */
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DELTIX_SERVER_URL: z.string().url().default('http://127.0.0.1:9090'),
  DELTIX_CREDENTIALS_PATH: z.string().min(1).optional(),
  // Path to a CA certificate to trust for HTTP (REST) calls to the control
  // plane — login, push/pull ticket issuance, versioning API. Required
  // whenever the server uses a self-signed certificate (the default for
  // local/dev deployments) — omit only when the server's certificate is
  // already trusted by the OS root store (e.g. a real CA-signed cert).
  DELTIX_HTTP_TLS_CA_PATH: z.string().min(1).optional(),
  // Overrides the TLS ServerName used for HTTP certificate verification when
  // the server URL uses a bare IP address (Bun/Node reject IP-address
  // ServerNames). Must match the DNS name the server's certificate was
  // issued for (our self-signed dev/test certs use CN=localhost).
  DELTIX_HTTP_TLS_SERVER_NAME_OVERRIDE: z.string().min(1).optional(),
  // Path to an existing `dolt` binary to use instead of the one the
  // binary-manager downloads/installs into `~/.deltix/bin/`. When set, the
  // binary-manager trusts it as-is (no download, no integrity re-verify it
  // did not record). Intended for CI/preinstalled setups.
  DELTIX_DOLT_BIN_PATH: z.string().min(1).optional(),
  // Dolt release version the binary-manager installs when no binary is
  // present on PATH. Pinned to match the version Deltix-Server installs.
  DELTIX_DOLT_VERSION: z.string().min(1).default('2.3.1'),
  // Root directory for locally-managed Dolt state and the installed binary.
  // Defaults to `~/.deltix`; overridable so tests and CI can isolate state.
  DELTIX_HOME: z.string().min(1).optional(),
  // Host/port the local `dolt sql-server` binds to (mysql-embedded context).
  // Loopback-only by default; 3306 is the conventional MySQL port. Persisted
  // via `deltix configure` so host names with a pre-installed MySQL/MariaDB
  // can pick a free port without exporting env vars by hand.
  DELTIX_LOCAL_HOST: z.string().min(1).default('127.0.0.1'),
  DELTIX_LOCAL_PORT: z.coerce.number().int().positive().default(3306),
});

export type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | undefined;

export function loadEnv(source: Record<string, string | undefined> = Bun.env): Env {
  if (!cachedEnv) {
    cachedEnv = envSchema.parse(source);
  }
  return cachedEnv;
}

/**
 * Applies persisted `deltix configure` defaults to `Bun.env` for any of the
 * connection-related variables not already explicitly set. Env vars always
 * win over persisted config — this only fills gaps. Must be called (once,
 * at process startup, before the first `loadEnv()`) for persisted config to
 * take effect, since `loadEnv()` caches its result on first call.
 */
export function applyPersistedConfigDefaults(config: {
  serverUrl?: string;
  httpTlsCaPath?: string;
  httpTlsServerNameOverride?: string;
  localHost?: string;
  localPort?: number;
  localDoltBinPath?: string;
}): void {
  const fallback: Record<string, string | undefined> = {
    DELTIX_SERVER_URL: config.serverUrl,
    DELTIX_HTTP_TLS_CA_PATH: config.httpTlsCaPath,
    DELTIX_HTTP_TLS_SERVER_NAME_OVERRIDE: config.httpTlsServerNameOverride,
    DELTIX_LOCAL_HOST: config.localHost,
    // mysql-embedded: the local Dolt SQL server's bind port and the Dolt
    // binary to use, so `deltix configure` can customise them once.
    DELTIX_LOCAL_PORT: config.localPort?.toString(),
    DELTIX_DOLT_BIN_PATH: config.localDoltBinPath,
  };
  for (const [key, value] of Object.entries(fallback)) {
    if (value !== undefined && Bun.env[key] === undefined) {
      Bun.env[key] = value;
    }
  }
}

/** Test-only helper to reset the cache between test cases. */
export function __resetEnvCacheForTests(): void {
  cachedEnv = undefined;
}
