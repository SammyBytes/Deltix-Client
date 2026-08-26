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
  // Heartbeat cadence while a Push/Pull is in flight, kept comfortably
  // below the server's ticket TTL (default 120s) so the sliding window
  // never lapses mid-transfer.
  DELTIX_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
});

export type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | undefined;

export function loadEnv(source: Record<string, string | undefined> = Bun.env): Env {
  if (!cachedEnv) {
    cachedEnv = envSchema.parse(source);
  }
  return cachedEnv;
}

/** Test-only helper to reset the cache between test cases. */
export function __resetEnvCacheForTests(): void {
  cachedEnv = undefined;
}
