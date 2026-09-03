import { getClientBuildInfo } from '../../shared/build-info';
import { loadEnv } from '../../shared/env';
import { buildFetchTlsOptions } from '../../shared/http-tls';
import { printInfo, printKeyValues } from '../output';

export async function runVersion(): Promise<number> {
  const clientInfo = await getClientBuildInfo();
  printInfo('Deltix-Client');
  printKeyValues({
    version: clientInfo.version,
    commit: clientInfo.commit,
  });

  const env = loadEnv();
  const tls = buildFetchTlsOptions({
    caCertPath: env.DELTIX_HTTP_TLS_CA_PATH,
    serverNameOverride: env.DELTIX_HTTP_TLS_SERVER_NAME_OVERRIDE,
  });

  let serverShown = false;
  try {
    const response = await fetch(new URL('/status', env.DELTIX_SERVER_URL), {
      signal: AbortSignal.timeout(3000),
      ...(tls ? { tls } : {}),
    });
    if (response.ok) {
      const server = await response.json();
      printInfo(`Deltix-Server (${env.DELTIX_SERVER_URL})`);
      printKeyValues({
        version: server.version ?? 'unknown',
        commit: server.commit ?? 'unknown',
        env: server.nodeEnv ?? 'unknown',
      });
      serverShown = true;
    }
  } catch {
    // Swallowed — fall through to the explanation below.
  }
  if (!serverShown) {
    printInfo(
      `(server version probe unavailable; run any data command to confirm connectivity — ${env.DELTIX_SERVER_URL})`,
    );
  }

  return 0;
}
