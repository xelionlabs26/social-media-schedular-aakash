import { describe, expect, it, vi } from 'vitest';
import { AutosaveController, type SaveResult, type SaveStatus } from './autosave';

type Patch = Record<string, string>;

function setup(results: SaveResult[] = []) {
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const saved: Patch[] = [];
  const statuses: SaveStatus[] = [];
  let gate: (() => void) | null = null;
  let hold = false;
  const c = new AutosaveController<Patch>({
    delayMs: 800,
    merge: (a, b) => ({ ...a, ...b }),
    onStatus: (s) => statuses.push(s),
    save: async (p) => {
      saved.push(p);
      if (hold) await new Promise<void>((r) => (gate = r));
      return results.shift() ?? { ok: true };
    },
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => {
      (h as { cleared: boolean }).cleared = true;
    },
  });
  const fireTimer = async () => {
    const t = [...timers].reverse().find((x) => !x.cleared);
    t!.cleared = true;
    t!.fn();
    await new Promise((r) => setTimeout(r, 0));
  };
  return {
    c,
    saved,
    statuses,
    timers,
    fireTimer,
    hold: () => (hold = true),
    release: () => {
      hold = false;
      gate?.();
    },
  };
}

describe('AutosaveController', () => {
  it('debounces keystrokes into one save after 800 ms', async () => {
    const { c, saved, timers, fireTimer, statuses } = setup();
    c.change({ body: 'a' });
    c.change({ body: 'ab' });
    c.change({ title: 'T' });
    expect(timers.filter((t) => !t.cleared)).toHaveLength(1);
    expect(timers[0]!.ms).toBe(800);
    await fireTimer();
    expect(saved).toEqual([{ body: 'ab', title: 'T' }]);
    expect(statuses.at(-1)).toBe('saved');
    expect(c.hasUnsaved()).toBe(false);
  });

  it('flush saves immediately (blur) and waits for it', async () => {
    const { c, saved } = setup();
    c.change({ body: 'x' });
    await c.flush();
    expect(saved).toEqual([{ body: 'x' }]);
    await c.flush(); // nothing pending: no extra request
    expect(saved).toHaveLength(1);
  });

  it('saves edits typed during a save afterwards, never two at once', async () => {
    const s = setup();
    s.hold();
    s.c.change({ body: 'one' });
    const first = s.c.flush();
    await new Promise((r) => setTimeout(r, 0));
    s.c.change({ body: 'two' });
    expect(s.saved).toHaveLength(1);
    s.release();
    await first;
    // flush() keeps going until everything typed so far is saved.
    expect(s.saved).toEqual([{ body: 'one' }, { body: 'two' }]);
    expect(s.c.getStatus()).toBe('saved');
  });

  it('keeps failed edits and retries them with the next change', async () => {
    const { c, saved, statuses } = setup([{ ok: false, error: 'offline' }]);
    c.change({ body: 'a' });
    await c.flush();
    expect(statuses.at(-1)).toBe('error');
    expect(c.hasUnsaved()).toBe(true);
    c.change({ title: 'b' });
    await c.flush();
    expect(saved).toEqual([{ body: 'a' }, { body: 'a', title: 'b' }]);
    expect(c.getStatus()).toBe('saved');
  });

  it('turns a thrown save into an error, not a crash', async () => {
    const onStatus = vi.fn();
    const c = new AutosaveController<Patch>({
      delayMs: 10,
      merge: (a, b) => ({ ...a, ...b }),
      onStatus,
      save: async () => {
        throw new Error('network');
      },
    });
    c.change({ a: '1' });
    await c.flush();
    expect(onStatus).toHaveBeenLastCalledWith('error', 'Could not reach the server.');
    c.dispose();
  });

  it('stops on a conflict until the owner chooses', async () => {
    const { c, saved, timers } = setup([{ ok: false, error: 'changed', conflict: true }]);
    c.change({ body: 'mine' });
    await c.flush();
    expect(c.getStatus()).toBe('conflict');
    const before = timers.length;
    c.change({ body: 'mine 2' });
    expect(timers.length).toBe(before); // no autosave while in conflict
    await c.resolveConflict();
    expect(saved.at(-1)).toEqual({ body: 'mine 2' });
    expect(c.getStatus()).toBe('saved');

    c.change({ body: 'x' });
    c.discard();
    expect(c.hasUnsaved()).toBe(false);
    expect(c.getStatus()).toBe('idle');
  });
});
