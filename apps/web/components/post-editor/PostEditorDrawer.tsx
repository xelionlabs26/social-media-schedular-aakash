'use client';

/**
 * Post editor drawer (PLAN.md §3.6): video + transcript/notes on the left, platform tabs with
 * live counters, refine buttons and autosave on the right, then When, History and the footer
 * (Delete · Move to drafts · Save & schedule). Opened from any card on Upload or Calendar.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Platform, TargetOptions } from '@app/db';
import type { TargetCard } from '@app/core/posts';
import { PLATFORM_LABELS, PLATFORM_ORDER } from '@app/core/platforms';
import { DISPLAY_STATUS_ICON } from '@app/core/status';
import { validateTargetText } from '@app/core/text';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Drawer } from '@/components/ui/drawer';
import { Tabs } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/toast';
import { usePolling } from '@/components/upload/usePolling';
import {
  addPlatformAction,
  deletePostAction,
  getPostCardAction,
  moveToDraftsAction,
  refineFieldAction,
  rewriteAllTextsAction,
  saveAssetTextAction,
  saveTargetText,
  schedulePostAction,
  setDraftTimeAction,
} from '@/lib/actions/posts';
import { AUTOSAVE_DELAY_MS, POLL_INTERVAL_MS } from '@/lib/upload/constants';
import type { EditorField } from '@/lib/upload/fields';
import type { TextPatch } from '@/lib/upload/post-service';
import { formatWhen, localInputToUtc, utcToLocalInput } from '@/lib/upload/time';
import type { EditorData } from '@/lib/upload/types';
import { AutosaveController, type SaveStatus } from './autosave';
import { HistorySection } from './HistorySection';
import { LOCKED_STATUSES, PlatformPanel, type TargetDraft } from './PlatformPanel';
import type { RefineChoice } from './RefineMenu';
import { VideoPane } from './VideoPane';
import { WhenSection, type WhenValue } from './WhenSection';

export interface PostEditorDrawerProps {
  /** Post to edit; null = closed. */
  postId: string | null;
  onClose: () => void;
  /** Called after any change is saved so the parent list can refresh. */
  onChanged?: () => void;
}

export function PostEditorDrawer({ postId, onClose, onChanged }: PostEditorDrawerProps) {
  if (postId === null) return null;
  // A new post gets a fresh editor (state, autosave timers, polling).
  return <Editor key={postId} postId={postId} onClose={onClose} onChanged={onChanged} />;
}

// ---------------------------------------------------------------------------------------------

const draftFromCard = (t: TargetCard): TargetDraft => ({
  title: t.title,
  body: t.body,
  hashtags: [...t.hashtags],
  tags: [...t.tags],
  options: { ...t.options },
  version: t.version,
});

/** When-section value from the post's current times. */
function whenFromCard(data: EditorData): WhenValue {
  const { card, timezone } = data;
  const targets = card.targets;
  const times = targets.map((t) => t.scheduledAt?.getTime?.() ?? null);
  const distinct = new Set(times.filter((t): t is number => t !== null));
  if (distinct.size > 1) {
    return {
      common: '',
      perApp: true,
      perPlatform: Object.fromEntries(
        targets.map((t) => [t.platform, utcToLocalInput(t.scheduledAt, timezone)]),
      ),
    };
  }
  const at = card.scheduledAt ?? targets.find((t) => t.scheduledAt)?.scheduledAt ?? null;
  return { common: utcToLocalInput(at, timezone), perApp: false, perPlatform: {} };
}

/** Local inputs -> ISO instants for the server actions (null = no time). */
function whenToIso(v: WhenValue, tz: string, platforms: Platform[]) {
  const iso = (s: string | undefined) =>
    s ? (localInputToUtc(s, tz)?.toISOString() ?? null) : null;
  if (!v.perApp) return { at: iso(v.common) };
  const perPlatformAt: Partial<Record<Platform, string | null>> = {};
  for (const p of platforms) perPlatformAt[p] = iso(v.perPlatform[p]);
  return { at: null, perPlatformAt };
}

function earliestIso(w: {
  at: string | null;
  perPlatformAt?: Partial<Record<Platform, string | null>>;
}) {
  const all = [w.at, ...Object.values(w.perPlatformAt ?? {})].filter((x): x is string =>
    Boolean(x),
  );
  return all.length ? Math.min(...all.map((x) => new Date(x).getTime())) : null;
}

type Busy = null | 'schedule' | 'drafts' | 'delete' | 'rewrite' | 'add';

function Editor({
  postId,
  onClose,
  onChanged,
}: { postId: string } & Omit<PostEditorDrawerProps, 'postId'>) {
  const toast = useToast();
  const onCloseRef = useRef(onClose);
  const onChangedRef = useRef(onChanged);
  useEffect(() => {
    onCloseRef.current = onClose;
    onChangedRef.current = onChanged;
  });

  const [data, setData] = useState<EditorData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, TargetDraft>>({});
  const draftsRef = useRef(drafts);
  const setDraftsSync = useCallback(
    (fn: (prev: Record<string, TargetDraft>) => Record<string, TargetDraft>) => {
      draftsRef.current = fn(draftsRef.current);
      setDrafts(draftsRef.current);
    },
    [],
  );
  const [saveState, setSaveState] = useState<
    Record<string, { status: SaveStatus; error?: string }>
  >({});
  const controllers = useRef(new Map<string, AutosaveController<TextPatch>>());
  const forceSave = useRef(new Set<string>());
  const [tab, setTab] = useState<Platform | null>(null);
  const [refining, setRefining] = useState<{ targetId: string; field: EditorField } | null>(null);
  const [transcript, setTranscript] = useState('');
  const [notes, setNotes] = useState('');
  const savedTexts = useRef({ transcript: '', notes: '' });
  const [writtenFrom, setWrittenFrom] = useState({ transcript: '', notes: '' });
  const [textsSaving, setTextsSaving] = useState(false);
  const [when, setWhen] = useState<WhenValue>({ common: '', perApp: false, perPlatform: {} });
  const serverWhen = useRef<WhenValue | null>(null);
  const whenTouched = useRef(false);
  const committedWhen = useRef('');
  const [busy, setBusy] = useState<Busy>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const confirmDeleteRef = useRef(false);
  const [addOpen, setAddOpen] = useState(false);
  const closeAttempts = useRef(0);
  const transcriptRef = useRef(transcript);
  const notesRef = useRef(notes);
  useEffect(() => {
    transcriptRef.current = transcript;
    notesRef.current = notes;
    confirmDeleteRef.current = confirmDelete;
  });

  const tz = data?.timezone ?? 'Asia/Kolkata';

  // ---- Autosave per target ----------------------------------------------------------------------
  const controllerFor = useCallback(
    (targetId: string) => {
      let c = controllers.current.get(targetId);
      if (!c) {
        c = new AutosaveController<TextPatch>({
          delayMs: AUTOSAVE_DELAY_MS,
          merge: (a, b) => ({ ...a, ...b }),
          onStatus: (status, error) =>
            setSaveState((s) => ({ ...s, [targetId]: { status, error } })),
          save: async (patch) => {
            const draft = draftsRef.current[targetId];
            const force = forceSave.current.delete(targetId);
            const res = await saveTargetText({
              targetId,
              patch,
              ...(force || !draft ? {} : { expectedVersion: draft.version }),
            });
            if (res.ok) {
              setDraftsSync((prev) =>
                prev[targetId]
                  ? { ...prev, [targetId]: { ...prev[targetId]!, version: res.version } }
                  : prev,
              );
              onChangedRef.current?.();
              return { ok: true };
            }
            return { ok: false, error: res.error, conflict: res.code === 'conflict' };
          },
        });
        controllers.current.set(targetId, c);
      }
      return c;
    },
    [setDraftsSync],
  );

  useEffect(() => {
    const map = controllers.current;
    return () => {
      // Save what was typed, then stop timers (also covers a parent closing us directly).
      for (const c of map.values()) {
        if (c.hasUnsaved()) void c.flush().finally(() => c.dispose());
        else c.dispose();
      }
      map.clear();
    };
  }, []);

  // ---- Loading --------------------------------------------------------------------------------
  const load = useCallback(
    async (initial: boolean) => {
      const res = await getPostCardAction(postId);
      if (!res.ok) {
        if (initial) setLoadError(res.error);
        else if (res.code === 'not_found') {
          toast('This post was deleted.', 'error');
          onCloseRef.current();
        }
        return;
      }
      const d = res.data;
      setData(d);
      setDraftsSync((prev) => {
        const next: Record<string, TargetDraft> = {};
        for (const t of d.card.targets) {
          const local = prev[t.id];
          const unsaved = controllers.current.get(t.id)?.hasUnsaved();
          // Never overwrite what the owner is typing; take the server version otherwise.
          next[t.id] = local && unsaved ? local : draftFromCard(t);
        }
        return next;
      });
      const serverTranscript = d.card.asset.transcript ?? '';
      const serverNotes = d.card.asset.notes ?? '';
      if (initial) {
        setTranscript(serverTranscript);
        setNotes(serverNotes);
        setWrittenFrom({ transcript: serverTranscript, notes: serverNotes });
        setTab((t) => t ?? d.card.targets[0]?.platform ?? null);
      } else {
        // Follow the server (e.g. the transcript arrived) unless the owner edited it.
        if (transcriptRef.current === savedTexts.current.transcript)
          setTranscript(serverTranscript);
        if (notesRef.current === savedTexts.current.notes) setNotes(serverNotes);
      }
      savedTexts.current = { transcript: serverTranscript, notes: serverNotes };
      const w = whenFromCard(d);
      serverWhen.current = w;
      if (initial || !whenTouched.current) {
        setWhen(w);
        committedWhen.current = JSON.stringify(w);
      }
      setTab((t) =>
        t && d.card.targets.some((x) => x.platform === t)
          ? t
          : (d.card.targets[0]?.platform ?? null),
      );
    },
    [postId, setDraftsSync, toast],
  );

  useEffect(() => {
    void load(true);
  }, [load]);

  const asset = data?.card.asset;
  const writing = Boolean(asset && asset.status !== 'ready' && asset.status !== 'failed');
  usePolling(writing, POLL_INTERVAL_MS, () => load(false));

  // When the AI finishes, the texts it wrote reflect the current transcript/notes.
  const wasWriting = useRef(writing);
  useEffect(() => {
    if (wasWriting.current && !writing) {
      setWrittenFrom({
        transcript: savedTexts.current.transcript,
        notes: savedTexts.current.notes,
      });
    }
    wasWriting.current = writing;
  }, [writing]);

  // ---- Saving helpers -------------------------------------------------------------------------
  const saveTexts = useCallback(async (): Promise<boolean> => {
    const patch: { transcript?: string; notes?: string } = {};
    if (transcriptRef.current !== savedTexts.current.transcript)
      patch.transcript = transcriptRef.current;
    if (notesRef.current !== savedTexts.current.notes) patch.notes = notesRef.current;
    if (!Object.keys(patch).length) return true;
    setTextsSaving(true);
    const res = await saveAssetTextAction({ postId, ...patch });
    setTextsSaving(false);
    if (!res.ok) {
      toast(res.error, 'error');
      return false;
    }
    savedTexts.current = { ...savedTexts.current, ...patch };
    return true;
  }, [postId, toast]);

  /** Saves everything typed so far; false if anything could not be saved. */
  const flushAll = useCallback(async (): Promise<boolean> => {
    const list = [...controllers.current.values()];
    await Promise.all(list.map((c) => c.flush()));
    const textsOk = await saveTexts();
    return textsOk && list.every((c) => c.getStatus() !== 'error' && c.getStatus() !== 'conflict');
  }, [saveTexts]);

  const requestClose = useCallback(async () => {
    // Escape inside the delete confirmation must not also close the drawer.
    if (confirmDeleteRef.current) return;
    const ok = await flushAll();
    if (!ok && closeAttempts.current === 0) {
      closeAttempts.current += 1;
      toast('Some changes are not saved. Close again to discard them.', 'error');
      return;
    }
    onCloseRef.current();
  }, [flushAll, toast]);
  const onDrawerClose = useCallback(() => void requestClose(), [requestClose]);

  // ---- Field handlers ---------------------------------------------------------------------------
  const onField = (targetId: string, field: EditorField, value: string | string[]) => {
    setDraftsSync((prev) => ({ ...prev, [targetId]: { ...prev[targetId]!, [field]: value } }));
    controllerFor(targetId).change({ [field]: value } as TextPatch);
  };

  const onOptions = (targetId: string, patch: Partial<TargetOptions>) => {
    const options = { ...draftsRef.current[targetId]!.options, ...patch };
    setDraftsSync((prev) => ({ ...prev, [targetId]: { ...prev[targetId]!, options } }));
    const c = controllerFor(targetId);
    c.change({ options });
    void c.flush();
  };

  const onRefine = async (targetId: string, field: EditorField, action: RefineChoice) => {
    const c = controllerFor(targetId);
    await c.flush();
    if (c.getStatus() === 'error' || c.getStatus() === 'conflict') {
      toast('Your last edit is not saved yet. Fix that first.', 'error');
      return;
    }
    setRefining({ targetId, field });
    const res = await refineFieldAction({
      targetId,
      field,
      action,
      expectedVersion: draftsRef.current[targetId]?.version,
    });
    setRefining(null);
    if (!res.ok) {
      toast(res.error, 'error');
      return;
    }
    setDraftsSync((prev) => ({
      ...prev,
      [targetId]: { ...prev[targetId]!, ...res.patch, version: res.version } as TargetDraft,
    }));
    setSaveState((s) => ({ ...s, [targetId]: { status: 'saved' } }));
    onChangedRef.current?.();
  };

  const reloadTarget = async (targetId: string) => {
    controllerFor(targetId).discard();
    await load(false);
  };
  const keepMine = (targetId: string) => {
    forceSave.current.add(targetId);
    void controllerFor(targetId)
      .resolveConflict()
      .then(() => controllerFor(targetId).flush());
  };

  // ---- When ---------------------------------------------------------------------------------------
  const targets = data?.card.targets ?? [];
  const platforms = targets.map((t) => t.platform);
  const allDrafts = targets.length > 0 && targets.every((t) => t.status === 'draft');
  const whenChanged = serverWhen.current
    ? JSON.stringify(when) !== JSON.stringify(serverWhen.current)
    : false;

  const commitWhen = async (v: WhenValue) => {
    whenTouched.current = true;
    if (!allDrafts) return;
    const key = JSON.stringify(v);
    if (key === committedWhen.current) return;
    const iso = whenToIso(v, tz, platforms);
    const invalid =
      (!v.perApp && v.common && !iso.at) ||
      (v.perApp && platforms.some((p) => v.perPlatform[p] && !iso.perPlatformAt?.[p]));
    if (invalid) return;
    const res = await setDraftTimeAction({ postId, ...iso });
    if (!res.ok) {
      toast(res.error, 'error');
      return;
    }
    committedWhen.current = key;
    whenTouched.current = false;
    onChangedRef.current?.();
    void load(false);
  };

  const whenIso = whenToIso(when, tz, platforms);
  const firstTime = earliestIso(whenIso);
  const timeInPast = firstTime !== null && firstTime <= Date.now();
  const whenHint = timeInPast
    ? 'This time has already passed. Pick a later one.'
    : allDrafts
      ? firstTime
        ? 'Saved as a dated draft. Nothing is posted until you click Save & schedule.'
        : 'No time yet: Save & schedule uses the next free posting slot.'
      : whenChanged
        ? 'New time not applied yet: click Save & schedule.'
        : 'Scheduled. Change the time and click Save & schedule to move it.';

  // ---- Footer actions -------------------------------------------------------------------------
  const draftTargets = targets.filter((t) => t.status === 'draft');
  const blocking = draftTargets.some((t) => {
    const d = drafts[t.id];
    return d
      ? validateTargetText(t.platform, d, { fbKind: d.options.fbKind }).some(
          (i) => i.severity === 'block',
        )
      : false;
  });
  const reschedulable = targets.some((t) =>
    ['scheduled', 'preparing', 'prepared'].includes(t.status),
  );
  const canSchedule = draftTargets.length > 0 || (reschedulable && whenChanged);
  const scheduleBlocked = !asset
    ? 'Loading…'
    : asset.status === 'failed'
      ? 'The video could not be processed.'
      : asset.status !== 'ready'
        ? 'Wait until the texts are written.'
        : blocking
          ? 'Fix the fields marked in red first.'
          : timeInPast
            ? 'Pick a time in the future.'
            : !canSchedule
              ? reschedulable
                ? 'Already scheduled.'
                : 'Nothing left to schedule.'
              : null;

  const saveAndSchedule = async () => {
    if (!(await flushAll())) {
      toast('Some changes could not be saved. Fix them first.', 'error');
      return;
    }
    setBusy('schedule');
    const res = await schedulePostAction({ postId, ...whenIso });
    setBusy(null);
    if (!res.ok) {
      toast(res.error, 'error');
      return;
    }
    const s = res.summary;
    onChangedRef.current?.();
    if (s.scheduled.length) {
      const warn = s.warnings.length ? ` · ${s.warnings[0]}` : '';
      toast(`Scheduled for ${formatWhen(s.scheduled[0]!.at, tz)}${warn}`, 'ok');
      onCloseRef.current();
    } else {
      toast(s.skipped[0]?.reason ?? 'Not scheduled.', 'error');
      await load(false);
    }
  };

  const moveDrafts = async () => {
    if (!(await flushAll())) return;
    setBusy('drafts');
    const res = await moveToDraftsAction(postId);
    setBusy(null);
    if (!res.ok) {
      toast(res.error, 'error');
      return;
    }
    toast('Moved to drafts.', 'ok');
    whenTouched.current = false;
    onChangedRef.current?.();
    await load(false);
  };

  const doDelete = async () => {
    setBusy('delete');
    const res = await deletePostAction(postId);
    setBusy(null);
    setConfirmDelete(false);
    if (!res.ok) {
      toast(res.error, 'error');
      return;
    }
    toast('Deleted.', 'ok');
    onChangedRef.current?.();
    onCloseRef.current();
  };

  const rewriteAll = async () => {
    if (!(await flushAll())) return;
    setBusy('rewrite');
    const res = await rewriteAllTextsAction({ postId, transcript, notes });
    setBusy(null);
    if (!res.ok) {
      toast(res.error, 'error');
      return;
    }
    savedTexts.current = { transcript, notes };
    toast('Rewriting all texts…', 'ok');
    onChangedRef.current?.();
    await load(false);
  };

  const addPlatform = async (platform: Platform) => {
    setAddOpen(false);
    setBusy('add');
    const res = await addPlatformAction({ postId, platform });
    setBusy(null);
    if (!res.ok) {
      toast(res.error, 'error');
      return;
    }
    if (res.warning) toast(res.warning, 'error');
    onChangedRef.current?.();
    await load(false);
    setTab(platform);
  };

  const closeConfirm = useCallback(() => setConfirmDelete(false), []);

  // ---- Render -----------------------------------------------------------------------------------
  const title = data ? data.card.asset.filename : 'Edit post';
  const activeTarget = targets.find((t) => t.platform === tab) ?? targets[0];
  const missing = PLATFORM_ORDER.filter((p) => !platforms.includes(p));
  const igTarget = targets.find((t) => t.platform === 'instagram');

  const footer = data ? (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="danger"
          size="sm"
          onClick={() => setConfirmDelete(true)}
          disabled={busy !== null}
        >
          Delete
        </Button>
        <div className="ml-auto flex flex-wrap justify-end gap-2">
          {reschedulable ? (
            <Button
              size="sm"
              onClick={() => void moveDrafts()}
              loading={busy === 'drafts'}
              disabled={busy !== null}
            >
              Move to drafts
            </Button>
          ) : null}
          <Button
            variant="primary"
            size="sm"
            onClick={() => void saveAndSchedule()}
            loading={busy === 'schedule'}
            disabled={busy !== null || scheduleBlocked !== null}
            aria-describedby="editor-schedule-hint"
          >
            Save &amp; schedule
          </Button>
        </div>
      </div>
      <p id="editor-schedule-hint" className="text-right text-xs text-muted">
        {scheduleBlocked ?? 'Nothing is posted until you click Save & schedule.'}
      </p>
    </div>
  ) : null;

  return (
    <Drawer open onClose={onDrawerClose} title={title} footer={footer}>
      {loadError ? (
        <div className="space-y-3 p-4 text-sm">
          <p className="text-danger">{loadError}</p>
          <Button
            size="sm"
            onClick={() => {
              setLoadError(null);
              void load(true);
            }}
          >
            Try again
          </Button>
        </div>
      ) : !data ? (
        <p className="p-4 text-sm text-muted" aria-live="polite">
          Loading…
        </p>
      ) : (
        <div className="grid gap-5 p-4 md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
          <VideoPane
            data={data}
            transcript={transcript}
            notes={notes}
            textsChanged={transcript !== writtenFrom.transcript || notes !== writtenFrom.notes}
            saving={textsSaving}
            rewriting={busy === 'rewrite'}
            writing={writing}
            onTranscript={setTranscript}
            onNotes={setNotes}
            onBlurTexts={() => void saveTexts()}
            onRewrite={() => void rewriteAll()}
          />

          <div className="min-w-0 space-y-6">
            {writing ? (
              <p
                className="flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2 text-sm"
                aria-live="polite"
              >
                <span
                  className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
                  aria-hidden
                />
                Writing captions… the texts appear here when ready.
              </p>
            ) : null}
            {asset?.status === 'failed' ? (
              <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger" role="alert">
                ! This video could not be processed{asset.error ? `: ${asset.error}` : '.'}
              </p>
            ) : null}

            <div className="flex items-end gap-2 border-b border-border">
              <Tabs
                className="min-w-0 flex-1 overflow-x-auto border-b-0"
                value={activeTarget?.platform ?? 'instagram'}
                onChange={(p) => setTab(p)}
                items={targets.map((t) => ({
                  key: t.platform,
                  label: (
                    <span className="inline-flex items-center gap-1 whitespace-nowrap">
                      {PLATFORM_LABELS[t.platform]}
                      <span
                        aria-hidden
                        className={t.display === 'needs_attention' ? 'text-danger' : 'text-muted'}
                      >
                        {DISPLAY_STATUS_ICON[t.display]}
                      </span>
                    </span>
                  ),
                }))}
              />
              {missing.length ? (
                <div className="relative mb-1 shrink-0">
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-haspopup="menu"
                    aria-expanded={addOpen}
                    loading={busy === 'add'}
                    onClick={() => setAddOpen((v) => !v)}
                  >
                    + add platform
                  </Button>
                  {addOpen ? (
                    <div
                      role="menu"
                      className="absolute top-full right-0 z-20 mt-1 w-40 rounded-lg border border-border bg-surface py-1 shadow-lg"
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') {
                          e.stopPropagation();
                          setAddOpen(false);
                        }
                      }}
                    >
                      {missing.map((p) => (
                        <button
                          key={p}
                          role="menuitem"
                          type="button"
                          className="block w-full px-3 py-1.5 text-left text-sm hover:bg-surface-2"
                          onClick={() => void addPlatform(p)}
                        >
                          {PLATFORM_LABELS[p]}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>

            {activeTarget && drafts[activeTarget.id] ? (
              <div role="tabpanel" aria-label={PLATFORM_LABELS[activeTarget.platform]}>
                <PlatformPanel
                  platform={activeTarget.platform}
                  draft={drafts[activeTarget.id]!}
                  card={activeTarget}
                  hashtagMax={data.hashtagMax[activeTarget.platform]}
                  timezone={tz}
                  account={data.accounts[activeTarget.platform]}
                  refiningField={refining?.targetId === activeTarget.id ? refining.field : null}
                  save={saveState[activeTarget.id] ?? { status: 'idle' }}
                  instagramBody={igTarget ? drafts[igTarget.id]?.body : undefined}
                  onField={(f, v) => onField(activeTarget.id, f, v)}
                  onOptions={(p) => onOptions(activeTarget.id, p)}
                  onRefine={(f, a) => void onRefine(activeTarget.id, f, a)}
                  onBlur={() => void controllerFor(activeTarget.id).flush()}
                  onReload={() => void reloadTarget(activeTarget.id)}
                  onKeepMine={() => keepMine(activeTarget.id)}
                />
              </div>
            ) : (
              <p className="text-sm text-muted">No platforms yet. Use “+ add platform”.</p>
            )}

            {targets.length && !targets.every((t) => LOCKED_STATUSES.includes(t.status)) ? (
              <WhenSection
                timezone={tz}
                platforms={platforms}
                value={when}
                hint={whenHint}
                onChange={(v) => {
                  whenTouched.current = true;
                  setWhen(v);
                }}
                onCommit={(v) => void commitWhen(v)}
              />
            ) : null}

            <HistorySection postId={postId} timezone={tz} />
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmDelete}
        title="Delete this post?"
        danger
        confirmLabel="Delete"
        loading={busy === 'delete'}
        onConfirm={() => void doDelete()}
        onCancel={closeConfirm}
      >
        {data ? (
          <p>
            <span className="font-medium break-all text-text">{data.card.asset.filename}</span> and
            its texts will be removed. Anything already scheduled on YouTube or Facebook is canceled
            there first. Posts that are already live stay online.
          </p>
        ) : null}
      </ConfirmDialog>
    </Drawer>
  );
}
