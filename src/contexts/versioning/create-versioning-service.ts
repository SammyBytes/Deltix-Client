import { VersioningApiAdapter } from '../../acl/versioning-api-adapter';
import { loadEnv } from '../../shared/env';
import { createSessionService } from '../session';
import { VersioningService } from './versioning.service';

export function createVersioningService(): VersioningService {
  const env = loadEnv();
  const session = createSessionService();
  const adapter = new VersioningApiAdapter(env.DELTIX_SERVER_URL, {
    caCertPath: env.DELTIX_HTTP_TLS_CA_PATH,
    serverNameOverride: env.DELTIX_HTTP_TLS_SERVER_NAME_OVERRIDE,
  });
  // On 401, transparently mint a fresh access token using the stored refresh
  // token and retry the request once. The CLI no longer needs to be re-logged
  // in every 15 minutes; the session refreshes itself.
  adapter.onAuthError = async () => session.mintAccessToken();
  return new VersioningService(session, adapter);
}
