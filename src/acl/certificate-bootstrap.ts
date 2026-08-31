/**
 * Trust-On-First-Use (TOFU) bootstrap for a self-signed server certificate,
 * used by `deltix configure` to save the user from manually copying a
 * `.crt` file off the server (the exact friction reported in production:
 * `scp`/`ssh cat` against a path that didn't exist, `sudo` needing a TTY,
 * etc.).
 *
 * This performs a raw TLS handshake against the target host:port with
 * certificate validation disabled *for this single bootstrap connection
 * only* (`rejectUnauthorized: false`), reads the peer's certificate, and
 * returns it PEM-encoded along with its SHA-256 fingerprint. The caller
 * MUST display the fingerprint and get explicit user confirmation before
 * trusting and persisting it — mirroring how SSH handles first-connection
 * host keys. This module never silently trusts anything; it only reduces
 * the manual-copy friction of an operation the user would otherwise have
 * to do by hand.
 */
import * as tls from 'node:tls';

export interface FetchedCertificate {
  /** PEM-encoded certificate, suitable for writing to a `.crt` file. */
  pem: string;
  /** SHA-256 fingerprint (colon-separated hex), for user confirmation. */
  fingerprint256: string;
  subject: string;
  issuer: string;
  validTo: string;
  /** DNS-style names listed in the certificate's Subject Alternative Name
   *  extension, in order. Non-IP SANs are the only values TLS clients can
   *  use as a server-name override, so the first one is the natural default
   *  for `deltix configure` when the server is reached by bare IP. */
  dnsNames: string[];
}

export class CertificateFetchError extends Error {
  constructor(host: string, port: number, cause: unknown) {
    super(`Could not fetch a certificate from ${host}:${port}: ${String(cause)}`);
    this.name = 'CertificateFetchError';
  }
}

function derToPem(raw: Buffer): string {
  const base64 = raw.toString('base64');
  const lines = base64.match(/.{1,64}/g) ?? [base64];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}

/**
 * Connects to `host:port` over TLS (ignoring certificate validity, since
 * the whole point is to bootstrap trust for an as-yet-untrusted
 * certificate) and returns the peer's leaf certificate.
 */
export function fetchServerCertificate(
  host: string,
  port: number,
  timeoutMs = 5_000,
): Promise<FetchedCertificate> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      {
        host,
        port,
        rejectUnauthorized: false,
        // Only used to complete the handshake; never used for validation.
        servername: /^(\d{1,3}\.){3}\d{1,3}$|:/.test(host) ? undefined : host,
        timeout: timeoutMs,
      },
      () => {
        try {
          const cert = socket.getPeerCertificate(false);
          socket.end();
          if (!cert?.raw) {
            reject(new CertificateFetchError(host, port, 'server presented no certificate'));
            return;
          }
          const altNames = (cert.subjectaltname ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
          const dnsNames = altNames
            .filter((entry) => entry.startsWith('DNS:'))
            .map((entry) => entry.slice('DNS:'.length));
          resolve({
            pem: derToPem(cert.raw),
            fingerprint256: cert.fingerprint256 ?? '',
            subject:
              typeof cert.subject?.CN === 'string'
                ? cert.subject.CN
                : JSON.stringify(cert.subject ?? {}),
            issuer:
              typeof cert.issuer?.CN === 'string'
                ? cert.issuer.CN
                : JSON.stringify(cert.issuer ?? {}),
            validTo: cert.valid_to ?? '',
            dnsNames,
          });
        } catch (err) {
          reject(new CertificateFetchError(host, port, err));
        }
      },
    );
    socket.on('timeout', () => {
      socket.destroy();
      reject(new CertificateFetchError(host, port, 'connection timed out'));
    });
    socket.on('error', (err) => reject(new CertificateFetchError(host, port, err)));
  });
}
