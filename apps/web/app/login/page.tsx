import { redirect } from 'next/navigation';
import { authConfigured, isOwner } from '@/lib/auth';
import { LoginForm } from './login-form';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Log in' };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const configured = authConfigured();
  if (configured && (await isOwner().catch(() => false))) redirect(safeNext(next));
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-4 py-10">
      <div className="mb-6 flex items-center gap-2">
        <img src="/icon.svg" alt="" className="h-8 w-8" />
        <h1 className="text-lg font-semibold">Social Media Scheduler</h1>
      </div>
      {configured ? (
        <LoginForm next={safeNext(next)} />
      ) : (
        <div className="rounded-xl border border-border bg-surface p-4 text-sm leading-relaxed">
          <p className="font-medium">Login isn&apos;t set up yet.</p>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted">
            <li>
              Run{' '}
              <code className="rounded bg-surface-2 px-1">
                pnpm hash-password &apos;your password&apos;
              </code>
            </li>
            <li>
              Put <code>OWNER_EMAIL</code>, <code>OWNER_PASSWORD_HASH</code> and{' '}
              <code>AUTH_SECRET</code> in <code>.env</code>
            </li>
            <li>Restart the app.</li>
          </ol>
        </div>
      )}
      <p className="mt-8 text-center text-xs text-muted">
        <a href="/privacy" className="hover:underline">
          Privacy
        </a>{' '}
        ·{' '}
        <a href="/terms" className="hover:underline">
          Terms
        </a>{' '}
        ·{' '}
        <a href="/data-deletion" className="hover:underline">
          Data deletion
        </a>
      </p>
    </main>
  );
}

function safeNext(next: string | undefined): string {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}
