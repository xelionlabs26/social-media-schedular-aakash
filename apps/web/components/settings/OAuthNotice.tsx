'use client';

/**
 * Result banner after an OAuth callback redirects back with ?connected=<platform> or
 * ?error=<message>. Dismissing it also removes the params from the URL so a reload doesn't
 * show it again.
 */
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';
import { cn } from '@/lib/cn';

const CONNECTED_LABEL: Record<string, string> = {
  youtube: 'YouTube',
  google: 'YouTube',
  meta: 'Facebook & Instagram',
  facebook: 'Facebook',
  instagram: 'Instagram',
};

export function OAuthNotice({
  connected,
  error,
}: {
  connected: string | null;
  error: string | null;
}) {
  const router = useRouter();
  const path = usePathname();
  const [open, setOpen] = useState(Boolean(connected || error));
  if (!open) return null;

  const isError = Boolean(error);
  const text = isError
    ? `Connecting failed: ${error}`
    : `${CONNECTED_LABEL[connected ?? ''] ?? 'Account'} connected.`;

  return (
    <div
      role={isError ? 'alert' : 'status'}
      className={cn(
        'flex items-start gap-3 rounded-[--radius-card] border px-4 py-3 text-sm',
        isError ? 'border-danger/40 bg-danger/5 text-danger' : 'border-ok/40 bg-ok/5 text-ok',
      )}
    >
      <span aria-hidden className="font-bold">
        {isError ? '!' : '✓'}
      </span>
      <span className="min-w-0 flex-1 break-words">{text}</span>
      <button
        type="button"
        className="rounded px-1 text-muted hover:text-text"
        aria-label="Dismiss"
        onClick={() => {
          setOpen(false);
          router.replace(`${path}#accounts`, { scroll: false });
        }}
      >
        ✕
      </button>
    </div>
  );
}
