import { VersioningLocalService } from '../../contexts/versioning-local';
import { BinaryManager } from '../../contexts/binary-manager';

export function newLocalService(
  homeDir?: string,
  binaryManager?: BinaryManager
): VersioningLocalService {
  const dir = homeDir ?? process.env.DELTIX_HOME ?? '/home/sammy/.deltix';
  const bm = binaryManager ?? new BinaryManager();
  return new VersioningLocalService({
    homeDir: dir,
    binaryManager: bm,
  });
}
