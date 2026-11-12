import { isAuthenticated, isUsingDefaultPassword } from '@/lib/auth';
import { getStorageMode, listStoredFiles, type StoredFileItem } from '@/lib/storage';
import VaultApp from '@/components/VaultApp';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const authenticated = await isAuthenticated();
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
    />
  );
}
