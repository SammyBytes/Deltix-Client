/**
 * Builds the TLS trust options for Bun's `fetch()` against Deltix-Server's
 * HTTP control plane (REST auth, ticket issuance, versioning API).
 *
 * This mirrors `GrpcClientTlsConfig` in `acl/grpc-transfer-client.ts` on
 * purpose: in the vast majority of real deployments the HTTP control plane
 * and the gRPC transfer engine present the *same* self-signed certificate
 * (see `install.sh`, which generates one cert used for both), so
 * `DELTIX_HTTP_TLS_CA_PATH`/`DELTIX_HTTP_TLS_SERVER_NAME_OVERRIDE` default
 * from the gRPC equivalents when not set explicitly (see
 * `shared/env.ts#applyPersistedConfigDefaults`) — a user only has to
 * provide the CA cert once.
 *
 * Without this, every HTTP call (`login`, `push`, `pull`, `repo`, ...)
 * against a self-signed server fails with a generic
 * `TypeError: self signed certificate`, and the only "fix" most users find
 * is the global, insecure `NODE_TLS_REJECT_UNAUTHORIZED=0` env var — which
 * disables certificate validation for the entire process, including
 * unrelated dependencies. Passing `ca` here trusts *only* this specific
 * certificate, for *only* Deltix HTTP calls.
 */
import { readFileSync } from 'node:fs';

export interface HttpTlsConfig {
  caCertPath?: string | undefined;
  serverNameOverride?: string | undefined;
}

const caFileCache = new Map<string, string>();

function readCaCert(path: string): string {
  const cached = caFileCache.get(path);
  if (cached !== undefined) return cached;
  const contents = readFileSync(path, 'utf8');
  caFileCache.set(path, contents);
  return contents;
}

/**
 * Returns Bun's `fetch(url, { tls })` option object for the given config,
 * or `undefined` when no CA override is configured (i.e. the server's
 * certificate is expected to already be trusted by the OS root store).
 */
export function buildFetchTlsOptions(
  config: HttpTlsConfig,
): { ca: string; serverName?: string } | undefined {
  if (!config.caCertPath) return undefined;
  const ca = readCaCert(config.caCertPath);
  return config.serverNameOverride ? { ca, serverName: config.serverNameOverride } : { ca };
}

/** Test-only helper to reset the CA file cache between test cases. */
export function __resetHttpTlsCacheForTests(): void {
  caFileCache.clear();
}
