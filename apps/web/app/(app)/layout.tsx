import { requireOwnerPage } from '@/lib/auth';
import { getDeps } from '@/lib/deps';
import { getAttentionTargets } from '@app/core/posts';
import { getSettings } from '@app/core/settings';
import { ToastProvider } from '@/components/ui/toast';
import { PrivacyBanner } from '@/components/settings/PrivacyBanner';
import { AppNav } from './nav';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  await requireOwnerPage();
  const { db, log } = getDeps();
  const settings = await getSettings(db);
  // The nav badge is a convenience: never let it break every page.
  const attentionCount = await getAttentionTargets(db).then(
    (rows) => rows.length,
    (e: unknown) => {
      log.warn('layout: attention count failed', { error: e });
      return 0;
    },
  );
  return (
    <ToastProvider>
      <div className="min-h-dvh">
        <AppNav attentionCount={attentionCount} />
        {settings.privacyAcceptedAt ? null : <PrivacyBanner />}
        <main className="mx-auto w-full max-w-6xl px-4 pb-24 pt-4 sm:px-6">{children}</main>
      </div>
    </ToastProvider>
  );
}
