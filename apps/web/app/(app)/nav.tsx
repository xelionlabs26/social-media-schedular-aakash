'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';

const LINKS = [
  { href: '/', label: 'Upload' },
  { href: '/calendar', label: 'Calendar' },
  { href: '/settings', label: 'Settings' },
];

export function AppNav({ attentionCount = 0 }: { attentionCount?: number }) {
  const path = usePathname();
  const many = attentionCount >= 50 ? '50+' : String(attentionCount);
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-surface/90 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-1 px-2 sm:px-6">
        <Link href="/" className="mr-1 flex shrink-0 items-center gap-2 font-semibold sm:mr-3">
          <img src="/icon.svg" alt="" className="h-6 w-6" />
          <span className="sr-only sm:not-sr-only">Social Media Scheduler</span>
        </Link>
        <nav className="flex min-w-0 gap-0.5 sm:gap-1" aria-label="Main">
          {LINKS.map((l) => {
            const active = l.href === '/' ? path === '/' : path.startsWith(l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'rounded-lg px-2 py-1.5 text-sm font-medium sm:px-3',
                  active ? 'bg-surface-2 text-text' : 'text-muted hover:text-text',
                )}
              >
                {l.label}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {attentionCount > 0 ? (
            <Link
              href="/calendar"
              className="inline-flex h-8 items-center gap-1 rounded-full bg-danger/10 px-2.5 text-xs font-semibold text-danger hover:bg-danger/15"
              aria-label={`${many} need${attentionCount === 1 ? 's' : ''} attention. Open the calendar.`}
            >
              <span aria-hidden>(!)</span>
              <span aria-hidden>{many}</span>
              <span aria-hidden className="hidden md:inline">
                need{attentionCount === 1 ? 's' : ''} attention
              </span>
            </Link>
          ) : null}
          <form action="/logout" method="post">
            <button
              aria-label="Log out"
              className="rounded-lg px-2 py-1.5 text-sm text-muted hover:text-text sm:px-3"
            >
              <span className="hidden sm:inline">Log out</span>
              <span className="sm:hidden" aria-hidden>
                ⎋
              </span>
            </button>
          </form>
        </div>
      </div>
    </header>
  );
}
