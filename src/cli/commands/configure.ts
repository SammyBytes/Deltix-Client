import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CertificateFetchError, fetchServerCertificate } from '../../acl/certificate-bootstrap';
import { ConfigStore, defaultConfigPath } from '../../contexts/config';
import {
  DEFAULT_MYSQL_PORT,
  DEFAULT_SERVER_PORT,
  DEFAULT_SERVER_URL,
} from '../../shared/constants';
import {
  printError,
  printInfo,
  printKeyValues,
  printSuccess,
  promptConfirm,
  promptText,
} from '../output';

const DEFAULT_TRUSTED_CERT_PATH = join(homedir(), '.deltix', 'trusted-server.crt');

/**
 * Interactive one-time connection setup. Persists to `~/.deltix/config.json`
 * so a first-time user isn't left to discover `DELTIX_*` env vars on
 * their own. Covers everything the client needs to talk to the server
 * and bring up the local Dolt engine:
 *
 *   - `serverUrl`              — REST URL of Deltix-Server
 *   - `httpTlsCaPath` / `httpTlsServerNameOverride`
 *                              — TLS trust for the REST endpoint
 *   - `localHost` / `localPort`  — bind address for the local Dolt SQL server
 *
 * Env vars, when set, still take precedence over this persisted config
 * (see shared/env.ts's `applyPersistedConfigDefaults`) — the wizard is
 * the human-friendly path; env vars are the CI / automation path.
 *
 * When the server uses HTTPS with a self-signed cert, offers to fetch it
 * automatically (Trust-On-First-Use, like an SSH host key) instead of
 * requiring the operator to manually copy a `.crt` file off the server —
 * the exact friction reported in production. The fetched certificate's
 * fingerprint is always shown for explicit confirmation before
 * anything is trusted or saved.
 */
export async function runConfigure(): Promise<number> {
  printInfo('Deltix connection setup (Ctrl+C to cancel; press Enter to keep the default)');

  const serverUrl = await promptText('Deltix-Server REST URL', {
    default: DEFAULT_SERVER_URL,
  });

  // Parse out the host from the REST URL so we can fetch its TLS cert and
  // (when reached by bare IP) suggest a DNS name for SNI.
  const parsed = new URL(serverUrl);
  const host = parsed.hostname || '127.0.0.1';
  const port = parsed.port
    ? Number(parsed.port)
    : parsed.protocol === 'https:'
      ? 443
      : DEFAULT_SERVER_PORT;
  const isIpAddress = /^(\d{1,3}\.){3}\d{1,3}$|:/.test(host);

  let httpTlsCaPath: string | undefined;
  let httpTlsServerNameOverride: string | undefined;
  let autoSuggestedOverride: string | undefined;

  if (parsed.protocol === 'https:') {
    const wantsAutoFetch = await promptConfirm(
      'Server uses HTTPS. Does it use a self-signed certificate that needs to be trusted ' +
        '(fetch it automatically instead of copying a .crt file by hand)?',
      { default: true },
    );
    if (wantsAutoFetch) {
      const fetched = await autoFetchAndTrustCertificate(host, port);
      httpTlsCaPath = fetched?.path;
      autoSuggestedOverride =
        fetched?.dnsNames.find((name) => !/^(\d{1,3}\.){3}\d{1,3}$|:/.test(name)) ?? undefined;
    }

    if (isIpAddress) {
      // Fall back to a stable, sensible default when the certificate's SAN
      // didn't reveal a DNS name (e.g. a pre-existing cert with only an IP).
      const overrideDefault = autoSuggestedOverride ?? 'localhost';
      if (autoSuggestedOverride) {
        printInfo(
          `"${host}" is an IP address. TLS clients cannot verify a bare IP as a server name, ` +
            `so this connection uses the DNS name the server's certificate identifies as — ` +
            `suggested \`${autoSuggestedOverride}\` from the certificate.`,
        );
      } else {
        printInfo(
          `"${host}" is an IP address. TLS requires a DNS-style server name for certificate ` +
            'verification (SNI), so you must provide the name the server certificate was issued for.',
        );
      }
      httpTlsServerNameOverride = await promptText('TLS server name override', {
        default: overrideDefault,
      });
    }

    if (!httpTlsCaPath) {
      const caPathAnswer = await promptText(
        'Path to a CA certificate to trust (leave blank if the server uses a publicly-trusted certificate)',
        { default: '' },
      );
      if (caPathAnswer.trim() !== '') httpTlsCaPath = caPathAnswer.trim();
    }
  }

  const localHost = await promptText('Local Dolt SQL bind host', {
    default: '127.0.0.1',
  });
  const localPortRaw = await promptText('Local Dolt SQL port (must be free)', {
    default: DEFAULT_MYSQL_PORT,
  });
  const localPort = Number.parseInt(localPortRaw, 10);

  const store = new ConfigStore(defaultConfigPath);
  await store.save({
    serverUrl,
    httpTlsCaPath,
    httpTlsServerNameOverride,
    localHost,
    localPort: Number.isFinite(localPort) ? localPort : DEFAULT_MYSQL_PORT,
  });

  printSuccess(`Configuration saved to ${defaultConfigPath}`);
  printKeyValues({
    serverUrl,
    localHost,
    localPort: Number.isFinite(localPort) ? localPort : DEFAULT_MYSQL_PORT,
    httpTlsCaPath,
    httpTlsServerNameOverride,
  });
  return 0;
}

/**
 * Fetches the server's certificate over a raw TLS handshake (with
 * validation disabled for that single bootstrap connection only), shows
 * its fingerprint, and — only after explicit user confirmation — writes it
 * to `~/.deltix/trusted-server.crt` and returns that path along with the DNS
 * names the certificate is valid for (the natural server-name override).
 * Returns `undefined` on failure or if the user declines to trust it, in
 * which case the caller falls back to prompting for a manual CA path.
 */
async function autoFetchAndTrustCertificate(
  host: string,
  port: number,
): Promise<{ path: string; dnsNames: string[] } | undefined> {
  printInfo(`Connecting to ${host}:${port} to fetch the server's certificate...`);
  let fetched: Awaited<ReturnType<typeof fetchServerCertificate>>;
  try {
    fetched = await fetchServerCertificate(host, port);
  } catch (err) {
    const message = err instanceof CertificateFetchError ? err.message : String(err);
    printError(`Could not fetch the certificate automatically: ${message}`);
    printInfo('Falling back to manual entry.');
    return undefined;
  }

  printInfo('Certificate received:');
  printKeyValues({
    subject: fetched.subject,
    issuer: fetched.issuer,
    validTo: fetched.validTo,
    sha256Fingerprint: fetched.fingerprint256,
  });
  printInfo(
    'Verify this fingerprint matches the one shown by the server operator (e.g. in the ' +
      'install.sh summary) before trusting it — this is the same trust model as an SSH host key.',
  );

  const trusted = await promptConfirm('Trust this certificate?', { default: false });
  if (!trusted) {
    printInfo('Certificate not trusted. Falling back to manual entry.');
    return undefined;
  }

  await mkdir(join(homedir(), '.deltix'), { recursive: true });
  await writeFile(DEFAULT_TRUSTED_CERT_PATH, fetched.pem, { mode: 0o600 });
  printSuccess(`Certificate saved to ${DEFAULT_TRUSTED_CERT_PATH}`);
  return { path: DEFAULT_TRUSTED_CERT_PATH, dnsNames: fetched.dnsNames };
}
