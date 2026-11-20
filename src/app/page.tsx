import { isAuthenticated, isUsingDefaultPassword } from '@/lib/auth';
import { getStorageMode, listStoredFiles, type StoredFileItem } from '@/lib/storage';
import { getActiveEntitlement } from '@/lib/monetization-server';
import VaultApp from '@/components/VaultApp';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const [authenticated, entitlement] = await Promise.all([
    isAuthenticated(),
    getActiveEntitlement(),
  ]);
  const storageMode = getStorageMode();
  const isDefaultPassword = isUsingDefaultPassword();

  let initialFiles: StoredFileItem[] = [];
  if (authenticated) {
    try {
      initialFiles = await listStoredFiles();
    } catch {
      initialFiles = [];
    }
  }

  return (
    <VaultApp
      initialAuthenticated={authenticated}
      initialStorageMode={storageMode}
      initialIsDefaultPassword={isDefaultPassword}
      initialFiles={initialFiles}
      initialEntitlement={entitlement}
    />
  );
}
