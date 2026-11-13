'use client';

import { useState } from 'react';
import { cn } from '@/lib/cn';

/** 9:16 thumbnail (first AI frame) with a neutral placeholder when there is none. */
export function Thumb({ url, className }: { url: string | null; className?: string }) {
  const [broken, setBroken] = useState(false);
  return (
    <span
      className={cn(
        'relative inline-flex aspect-[9/16] shrink-0 items-center justify-center overflow-hidden rounded bg-surface-2 text-muted',
        className,
      )}
      aria-hidden
    >
      {url && !broken ? (
        // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL
        <img
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover"
          onError={() => setBroken(true)}
          draggable={false}
        />
      ) : (
        <span className="text-[10px]">▶</span>
      )}
    </span>
  );
}
