import { requireOwnerPage } from '@/lib/auth';
import { ToastProvider } from '@/components/ui/toast';
import { AppNav } from './nav';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  await requireOwnerPage();
  return (
    <ToastProvider>
      <div className="min-h-dvh">
        <AppNav />
        <main className="mx-auto w-full max-w-6xl px-4 pb-24 pt-4 sm:px-6">{children}</main>
      </div>
    </ToastProvider>
  );
}
