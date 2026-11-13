/**
 * Upload screen (home). Server part: reads the batch named in ?batch=… (so a refresh shows the
 * same cards), settings and account states; the interactive screen is UploadScreen.
 */
import { requireOwnerPage } from '@/lib/auth';
import { getDeps } from '@/lib/deps';
import { isUuid, loadUploadPageData } from '@/lib/upload/batch-view';
import { UploadScreen } from '@/components/upload/UploadScreen';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Upload' };

export default async function UploadPage({
  searchParams,
}: {
  searchParams: Promise<{ batch?: string | string[] }>;
}) {
  await requireOwnerPage();
  const { batch } = await searchParams;
  const batchId = typeof batch === 'string' && isUuid(batch) ? batch : null;
  const data = await loadUploadPageData(getDeps(), batchId);
  // A different batch (or "Start a new batch") gets a fresh screen state.
  return <UploadScreen key={data.view?.batch.id ?? 'new'} initial={data} />;
}
