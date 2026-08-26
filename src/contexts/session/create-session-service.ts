import { homedir } from 'node:os';
import { join } from 'node:path';
import { AuthApiAdapter } from '../../acl/auth-api-adapter';
import { loadEnv } from '../../shared/env';
import { SessionService } from './session.service';

const DEFAULT_CREDENTIALS_PATH = join(homedir(), '.deltix', 'credentials.json');

export function createSessionService(): SessionService {
  const env = loadEnv();
  const authApi = new AuthApiAdapter(env.DELTIX_SERVER_URL);
  const credentialsPath = env.DELTIX_CREDENTIALS_PATH ?? DEFAULT_CREDENTIALS_PATH;
  return new SessionService(authApi, credentialsPath);
}
