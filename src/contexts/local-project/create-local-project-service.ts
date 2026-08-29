import { LocalProjectService } from './local-project.service';

/**
 * Builds the default `LocalProjectService`. It has no external dependencies —
 * it operates purely on the on-disk `.deltix` binding of the caller's working
 * directory.
 */
export function createLocalProjectService(): LocalProjectService {
  return new LocalProjectService();
}
