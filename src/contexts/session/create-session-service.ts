import { homedir } from 'node:os';
import { join } from 'node:path';
import { AuthApiAdapter } from '../../acl/auth-api-adapter';
import { loadEnv } from '../../shared/env';
import { SessionService } from './session.service';

const DEFAULT_CREDENTIALS_PATH = join(homedir(), '.deltix', 'credentials.json');

export function createSessionService(): SessionService {
  const env = loadEnv();
  const authApi = new AuthApiAdapter(env.DELTIX_SERVER_URL, {
    caCertPath: env.DELTIX_HTTP_TLS_CA_PATH,
    serverNameOverride: env.DELTIX_HTTP_TLS_SERVER_NAME_OVERRIDE,
  });
  const credentialsPath = env.DELTIX_CREDENTIALS_PATH ?? DEFAULT_CREDENTIALS_PATH;
  return new SessionService(authApi, credentialsPath);
}
