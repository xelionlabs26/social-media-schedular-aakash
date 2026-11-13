'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';

const LINKS = [
  { href: '/', label: 'Upload' },
  { href: '/calendar', label: 'Calendar' },
  { href: '/settings', label: 'Settings' },
];

export function AppNav() {
  const path = usePathname();
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-surface/90 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-1 px-4 sm:px-6">
        <Link href="/" className="mr-3 flex items-center gap-2 font-semibold">
          <img src="/icon.svg" alt="" className="h-6 w-6" />
          <span className="hidden sm:inline">Social Media Scheduler</span>
        </Link>
        <nav className="flex gap-1" aria-label="Main">
          {LINKS.map((l) => {
            const active = l.href === '/' ? path === '/' : path.startsWith(l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'rounded-lg px-3 py-1.5 text-sm font-medium',
                  active ? 'bg-surface-2 text-text' : 'text-muted hover:text-text',
                )}
              >
                {l.label}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto">
          <form action="/logout" method="post">
            <button className="rounded-lg px-3 py-1.5 text-sm text-muted hover:text-text">
              Log out
            </button>
          </form>
        </div>
      </div>
    </header>
  );
}
