import { VersioningApiAdapter } from '../../acl/versioning-api-adapter';
import { loadEnv } from '../../shared/env';
import { createSessionService } from '../session';
import { VersioningService } from './versioning.service';

export function createVersioningService(): VersioningService {
  const env = loadEnv();
  return new VersioningService(
    createSessionService(),
    new VersioningApiAdapter(env.DELTIX_SERVER_URL),
  );
}
