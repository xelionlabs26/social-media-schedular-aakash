'use client';

import { useEffect, useRef } from 'react';

/**
 * Calls `tick` every `intervalMs` while `active`, one call at a time, paused while the tab is
 * hidden (and run once right away when it becomes visible again).
 */
export function usePolling(active: boolean, intervalMs: number, tick: () => Promise<void>): void {
  const tickRef = useRef(tick);
  useEffect(() => {
    tickRef.current = tick;
  }, [tick]);

  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let running = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = () => {
      clearTimeout(timer);
      if (!stopped) timer = setTimeout(run, intervalMs);
    };
    const run = async () => {
      if (stopped || running) return;
      if (document.visibilityState !== 'visible') return; // resumed by visibilitychange
      running = true;
      try {
        await tickRef.current();
      } catch {
        /* the next tick tries again */
      } finally {
        running = false;
        schedule();
      }
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !running) {
        clearTimeout(timer);
        void run();
      }
    };
    schedule();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [active, intervalMs]);
}
