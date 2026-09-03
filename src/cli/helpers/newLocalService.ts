import { BinaryManager, defaultHomeDir } from '../../contexts/binary-manager';
import { VersioningLocalService } from '../../contexts/versioning-local';

export function newLocalService(
  homeDir?: string,
  binaryManager?: BinaryManager,
): VersioningLocalService {
  const dir = homeDir ?? process.env.DELTIX_HOME ?? defaultHomeDir();
  const bm = binaryManager ?? new BinaryManager();
  return new VersioningLocalService({
    homeDir: dir,
    binaryManager: bm,
  });
}
