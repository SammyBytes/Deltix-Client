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
  // Fase 3: gRPC transfer engine target. Host/port only — TLS is always
  // required (no plaintext code path on the server), so the client never
  // has an "insecure" option here either.
  DELTIX_GRPC_HOST: z.string().min(1).default('127.0.0.1'),
  DELTIX_GRPC_PORT: z.coerce.number().int().positive().default(50051),
  // Path to a CA certificate to trust for the gRPC TLS connection. Required
  // whenever the server uses a self-signed certificate (the default for
  // local/dev deployments) — omit only when the server's certificate is
  // already trusted by the OS root store (e.g. a real CA-signed cert).
  DELTIX_GRPC_TLS_CA_PATH: z.string().min(1).optional(),
  // Overrides SNI/TLS ServerName verification when DELTIX_GRPC_HOST is an
  // IP address (Node's TLS stack rejects IP ServerNames outright). Must
  // match the DNS name the server's certificate was issued for (our
  // self-signed dev/test certs use CN=localhost).
  DELTIX_GRPC_TLS_SERVER_NAME_OVERRIDE: z.string().min(1).optional(),
  // Path to a CA certificate to trust for HTTP (REST) calls to the control
  // plane — login, push/pull ticket issuance, versioning API. In most real
  // deployments this is the *same* certificate as the gRPC one (the
  // installer generates one self-signed cert used for both), so
  // `applyPersistedConfigDefaults()` falls back to `DELTIX_GRPC_TLS_CA_PATH`
  // when this is not set explicitly. Without it, any self-signed server
  // certificate causes every HTTP call to fail with
  // `TypeError: self signed certificate`.
  DELTIX_HTTP_TLS_CA_PATH: z.string().min(1).optional(),
  // Overrides the TLS ServerName used for HTTP certificate verification,
  // for the same reason as DELTIX_GRPC_TLS_SERVER_NAME_OVERRIDE (Node/Bun's
  // TLS stack rejects IP-address ServerNames). Falls back to
  // DELTIX_GRPC_TLS_SERVER_NAME_OVERRIDE when not set explicitly.
  DELTIX_HTTP_TLS_SERVER_NAME_OVERRIDE: z.string().min(1).optional(),
  // Heartbeat cadence while a Push/Pull is in flight, kept comfortably
  // below the server's ticket TTL (default 120s) so the sliding window
  // never lapses mid-transfer.
  DELTIX_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
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
  grpcHost?: string;
  grpcPort?: number;
  grpcTlsCaPath?: string;
  grpcTlsServerNameOverride?: string;
  httpTlsCaPath?: string;
  httpTlsServerNameOverride?: string;
}): void {
  const fallback: Record<string, string | undefined> = {
    DELTIX_SERVER_URL: config.serverUrl,
    DELTIX_GRPC_HOST: config.grpcHost,
    DELTIX_GRPC_PORT: config.grpcPort?.toString(),
    DELTIX_GRPC_TLS_CA_PATH: config.grpcTlsCaPath,
    DELTIX_GRPC_TLS_SERVER_NAME_OVERRIDE: config.grpcTlsServerNameOverride,
    // The HTTP control plane and gRPC transfer engine present the same
    // certificate in most real deployments, so default the HTTP-specific
    // values from their gRPC counterparts when not explicitly configured.
    DELTIX_HTTP_TLS_CA_PATH: config.httpTlsCaPath ?? config.grpcTlsCaPath,
    DELTIX_HTTP_TLS_SERVER_NAME_OVERRIDE:
      config.httpTlsServerNameOverride ?? config.grpcTlsServerNameOverride,
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
