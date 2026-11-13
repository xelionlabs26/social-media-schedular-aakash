'use client';

/**
 * Upload screen (home, PLAN.md §3.2–3.6): drop zone, batch bar, one card per video, and the
 * Schedule footer. The batch id lives in the URL (?batch=…) so a refresh shows the same cards.
 */
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { PostEditorDrawer } from '@/components/post-editor/PostEditorDrawer';
import { useToast } from '@/components/ui/toast';
import {
  applyToAllAction,
  getBatchCardsAction,
  removeUploadAction,
  reorderAction,
  restartUploadAction,
  retryProcessingAction,
  scheduleBatchAction,
  startUploads,
} from '@/lib/actions/upload';
import { setDraftTimeAction } from '@/lib/actions/posts';
import { computeApplyPlan, type ApplyPlan } from '@/lib/upload/apply-plan';
import { buildCardModel, type CardModel } from '@/lib/upload/card-model';
import { POLL_INTERVAL_MS } from '@/lib/upload/constants';
import { videoTypeFor } from '@/lib/upload/format';
import {
  applyOrder,
  detectOrder,
  ORDER_LABELS,
  sortForMode,
  type OrderMode,
} from '@/lib/upload/order';
import { computeScheduleState } from '@/lib/upload/readiness';
import { rejectionMessage, screenFiles } from '@/lib/upload/select';
import type {
  BatchItem,
  BatchSettings,
  ScheduleSummary,
  UploadPageData,
  WhenRule,
} from '@/lib/upload/types';
import { ApplyDialog, describeWhen } from './ApplyDialog';
import { AssetCard } from './AssetCard';
import { BatchBar } from './BatchBar';
import { CardList } from './CardList';
import { DropOverlay, DropZone, useWindowFileDrop } from './DropZone';
import { ScheduleFooter, ScheduleResultPanel } from './ScheduleFooter';
import { EMPTY_SNAPSHOT, getUploadSession, type LocalFile, type UploadSession } from './session';
import { usePolling } from './usePolling';

/** Files sent to startUploads that have no asset id yet. */
interface PendingFile {
  local: LocalFile;
  name: string;
  size: number;
  type: string;
}

const THUMB_REFRESH_MS = 60 * 60_000;
const noopSubscribe = () => () => {};
const emptySnapshot = () => EMPTY_SNAPSHOT;

function initialSettings(data: UploadPageData): BatchSettings {
  const saved = data.view?.batch.settings;
  const base: BatchSettings = saved ?? {
    platforms: data.defaultPlatforms,
    notes: '',
    when: { mode: 'next_free', startDate: data.today },
  };
  // A start date in the past means "from today".
  const when: WhenRule =
    base.when.mode === 'next_free'
      ? {
          mode: 'next_free',
          startDate:
            base.when.startDate && base.when.startDate >= data.today
              ? base.when.startDate
              : data.today,
        }
      : base.when;
  return { ...base, when };
}

const bySortIndex = (a: BatchItem, b: BatchItem) =>
  a.sortIndex - b.sortIndex || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();

const randomKey = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`;

export function UploadScreen({ initial }: { initial: UploadPageData }) {
  const toast = useToast();
  const tz = initial.timezone;

  // ---- Upload session (browser only; the server renders an empty snapshot) ------------------
  const [session, setSession] = useState<UploadSession | null>(null);
  useEffect(() => setSession(getUploadSession()), []);
  const snap = useSyncExternalStore(
    session?.subscribe ?? noopSubscribe,
    session?.getSnapshot ?? emptySnapshot,
    emptySnapshot,
  );
  const uploadById = useMemo(() => new Map(snap.uploads.map((u) => [u.id, u])), [snap.uploads]);

  // ---- Screen state ---------------------------------------------------------------------------
  const [batchId, setBatchId] = useState<string | null>(initial.view?.batch.id ?? null);
  const [settings, setSettings] = useState<BatchSettings>(() => initialSettings(initial));
  const [savedWhen, setSavedWhen] = useState<WhenRule | null>(
    initial.view?.batch.settings.when ?? null,
  );
  const [items, setItems] = useState<BatchItem[]>(() =>
    [...(initial.view?.items ?? [])].sort(bySortIndex),
  );
  const [pending, setPending] = useState<PendingFile[]>([]);
  const [order, setOrder] = useState<OrderMode>(() => detectOrder(initial.view?.items ?? []));
  const [editing, setEditing] = useState<string | null>(null);
  const [applyPlan, setApplyPlan] = useState<ApplyPlan | null>(null);
  const [rewriteReady, setRewriteReady] = useState(false);
  const [applying, setApplying] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const [result, setResult] = useState<{ summary: ScheduleSummary; draftMode: boolean } | null>(
    null,
  );

  // Latest values for async callbacks.
  const batchIdRef = useRef(batchId);
  const settingsRef = useRef(settings);
  const editingRef = useRef(editing);
  const itemsRef = useRef(items);
  const singleUploadRef = useRef<string | null>(null);
  const thumbTimes = useRef(new Map<string, number>());
  useEffect(() => {
    batchIdRef.current = batchId;
    settingsRef.current = settings;
    editingRef.current = editing;
    itemsRef.current = items;
  });

  // ---- Refresh (poll) -------------------------------------------------------------------------
  const refreshing = useRef(false);
  const refreshAgain = useRef(false);
  const refresh = useCallback(async (): Promise<void> => {
    const id = batchIdRef.current;
    if (!id) return;
    if (refreshing.current) {
      refreshAgain.current = true;
      return;
    }
    refreshing.current = true;
    try {
      const res = await getBatchCardsAction(id);
      if (!res.ok) {
        if (res.code === 'unauthorized') toast(res.error, 'error');
        return;
      }
      setItems((prev) => {
        const prevById = new Map(prev.map((i) => [i.assetId, i]));
        const now = Date.now();
        const next = res.view.items.map((it) => {
          const old = prevById.get(it.assetId);
          // Keep a still-valid thumbnail URL so images don't reload on every poll.
          const age = now - (thumbTimes.current.get(it.assetId) ?? 0);
          if (old?.thumbUrl && it.thumbUrl && age < THUMB_REFRESH_MS) {
            return { ...it, thumbUrl: old.thumbUrl };
          }
          if (it.thumbUrl) thumbTimes.current.set(it.assetId, now);
          return it;
        });
        // Files this tab registered moments ago may not be in the response yet.
        const seen = new Set(next.map((i) => i.assetId));
        for (const old of prev) if (!seen.has(old.assetId) && old.post === null) next.push(old);
        return next.sort(bySortIndex);
      });
    } finally {
      refreshing.current = false;
      if (refreshAgain.current) {
        refreshAgain.current = false;
        void refresh();
      }
    }
  }, [toast]);

  const shownWarnings = useRef(new Set<string>());
  const refreshSoon = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRefresh = useCallback(() => {
    if (refreshSoon.current) clearTimeout(refreshSoon.current);
    refreshSoon.current = setTimeout(() => void refresh(), 300);
  }, [refresh]);

  // completeUpload finished: show the post; with a single file, open the editor right away.
  useEffect(() => {
    if (!session) return;
    session.handlers.onFinalized = (assetId, postId, warning) => {
      // The same warning (e.g. "worker not running") would repeat for every file: show it once.
      if (warning && !shownWarnings.current.has(warning)) {
        shownWarnings.current.add(warning);
        toast(warning);
      }
      scheduleRefresh();
      if (singleUploadRef.current === assetId && editingRef.current === null) {
        singleUploadRef.current = null;
        setEditing(postId);
      }
    };
    return () => {
      session.handlers.onFinalized = undefined;
    };
  }, [session, toast, scheduleRefresh]);

  const needsPoll = items.some((i) => {
    if (i.post) {
      return (
        i.post.display === 'processing' ||
        i.post.display === 'publishing' ||
        i.assetStatus === 'uploaded' ||
        i.assetStatus === 'processing'
      );
    }
    return uploadById.get(i.assetId)?.phase === 'done';
  });
  usePolling(Boolean(batchId) && needsPoll, POLL_INTERVAL_MS, refresh);

  // Leaving the page stops uploads; warn first.
  useEffect(() => {
    if (!session) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (session.queue.isBusy()) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [session]);

  // ---- Order ------------------------------------------------------------------------------------
  const persistOrder = useCallback(
    async (ids: string[]) => {
      const id = batchIdRef.current;
      if (!id) return;
      const before = itemsRef.current;
      setItems(applyOrder(before, ids));
      const res = await reorderAction(id, ids);
      if (!res.ok) {
        toast(res.error, 'error');
        setItems(before);
      }
    },
    [toast],
  );

  const changeOrder = (mode: OrderMode) => {
    setOrder(mode);
    if (mode !== 'custom') void persistOrder(sortForMode(items, mode));
  };

  // ---- Adding files ---------------------------------------------------------------------------
  const addFiles = useCallback(
    async (files: File[]) => {
      if (!session) return;
      const screened = screenFiles(files);
      if (screened.rejected.length) toast(rejectionMessage(screened.rejected), 'error');
      if (screened.overflow.length) {
        toast(
          `Only 100 videos at a time: drop the other ${screened.overflow.length} next.`,
          'error',
        );
      }
      if (!screened.accepted.length) return;
      const current = settingsRef.current;
      if (current.platforms.length === 0) {
        toast('Pick at least one platform under “Post to” first.', 'error');
        return;
      }
      const batch: PendingFile[] = screened.accepted.map(({ file, type }) => ({
        local: { localKey: randomKey(), file },
        name: file.name,
        size: file.size,
        type,
      }));
      setPending((p) => [...p, ...batch]);
      for (const p of batch) session.probe(p.local.localKey, p.local.file);

      const res = await startUploads(
        batch.map((p) => ({ name: p.name, size: p.size, type: p.type })),
        current,
        batchIdRef.current,
      );
      setPending((p) => p.filter((x) => !batch.includes(x)));
      if (!res.ok) {
        toast(res.error, 'error');
        return;
      }
      if (res.batchId !== batchIdRef.current) {
        batchIdRef.current = res.batchId;
        setBatchId(res.batchId);
        // Native history API: Next.js syncs it with the router without a server round trip.
        window.history.replaceState(null, '', `/?batch=${res.batchId}`);
      }
      setSavedWhen(current.when);
      const now = new Date();
      setItems((prev) =>
        [
          ...prev,
          ...res.items.map((it): BatchItem => ({
            assetId: it.assetId,
            filename: batch[it.index]!.name,
            sizeBytes: batch[it.index]!.size,
            assetStatus: 'uploading',
            sortIndex: it.sortIndex,
            createdAt: new Date(now.getTime() + it.index),
            notes: current.notes,
            thumbUrl: null,
            post: null,
          })),
        ].sort(bySortIndex),
      );
      singleUploadRef.current = res.items.length === 1 ? res.items[0]!.assetId : null;
      // Upload in card order so the first cards are ready first.
      session.start(
        [...res.items]
          .sort((a, b) => a.sortIndex - b.sortIndex)
          .map((it) => ({
            assetId: it.assetId,
            local: batch[it.index]!.local,
            target: it.target,
            chunkSize: it.chunkSize,
          })),
      );
    },
    [session, toast],
  );

  const dragging = useWindowFileDrop(
    Boolean(session) && editing === null && applyPlan === null,
    (files) => void addFiles(files),
  );

  // ---- Card actions -----------------------------------------------------------------------------
  const removeAsset = async (assetId: string) => {
    session?.forget(assetId);
    const res = await removeUploadAction(assetId);
    if (!res.ok) {
      toast(res.error, 'error');
      return;
    }
    setItems((prev) => prev.filter((i) => i.assetId !== assetId));
  };

  const reselect = async (assetId: string, file: File) => {
    if (!session) return;
    const type = videoTypeFor(file.name, file.type);
    const screened = screenFiles([file]);
    if (!type || !screened.accepted.length) {
      toast(rejectionMessage(screened.rejected), 'error');
      return;
    }
    const res = await restartUploadAction(assetId, { name: file.name, size: file.size, type });
    if (!res.ok) {
      toast(res.error, 'error');
      return;
    }
    const local = { localKey: randomKey(), file };
    session.probe(local.localKey, file);
    setItems((prev) =>
      prev.map((i) =>
        i.assetId === assetId ? { ...i, filename: file.name, sizeBytes: file.size } : i,
      ),
    );
    session.start([{ assetId, local, target: res.upload.target, chunkSize: res.upload.chunkSize }]);
  };

  const retryProcessing = async (assetId: string) => {
    const res = await retryProcessingAction(assetId);
    if (!res.ok) toast(res.error, 'error');
    else toast('Processing again…', 'ok');
    scheduleRefresh();
  };

  const pickTime = async (postId: string, at: Date | null): Promise<boolean> => {
    const res = await setDraftTimeAction({ postId, at: at ? at.toISOString() : null });
    if (!res.ok) {
      toast(res.error, 'error');
      return false;
    }
    scheduleRefresh();
    return true;
  };

  // ---- Apply to all -----------------------------------------------------------------------------
  const applyInput = items.map((i) => ({
    assetId: i.assetId,
    filename: i.filename,
    notes: i.notes,
    assetStatus: i.post?.asset.status ?? i.assetStatus,
    targets: i.post
      ? i.post.targets.map((t) => ({ platform: t.platform, status: t.status }))
      : null,
  }));
  const livePlan = computeApplyPlan(applyInput, settings, savedWhen);
  const barDirty = livePlan.changes.some((c) => c.add.length || c.remove.length || c.notesChanged);

  const openApply = () => {
    setRewriteReady(false);
    setApplyPlan(livePlan);
  };
  const closeApply = useCallback(() => setApplyPlan(null), []);
  const confirmApply = async () => {
    const id = batchIdRef.current;
    if (!applyPlan?.hasChanges || !id) {
      setApplyPlan(null);
      return;
    }
    setApplying(true);
    const res = await applyToAllAction({ batchId: id, settings, rewriteReady });
    setApplying(false);
    setApplyPlan(null);
    if (!res.ok) {
      toast(res.error, 'error');
      return;
    }
    setSavedWhen(settings.when);
    const r = res.result;
    const parts = [`Updated ${r.changedCards} video${r.changedCards === 1 ? '' : 's'}`];
    if (r.kept.length) parts.push(`${r.kept.length} already scheduled kept`);
    if (r.warnings.length) parts.push(r.warnings[0]!);
    toast(parts.join(' · '), r.warnings.length ? 'error' : 'ok');
    await refresh();
  };

  // ---- Cards ------------------------------------------------------------------------------------
  const models = new Map<string, CardModel>();
  for (const item of items) {
    const local = snap.locals[item.assetId];
    const probe = local ? snap.probes[local.localKey] : undefined;
    models.set(item.assetId, buildCardModel(item, uploadById.get(item.assetId), probe));
  }

  const schedule = computeScheduleState(
    items.map((i) => {
      const phase = uploadById.get(i.assetId)?.phase;
      return {
        assetId: i.assetId,
        filename: i.filename,
        post: i.post,
        uploading:
          phase === 'queued' || phase === 'uploading' || phase === 'finalizing' || phase === 'done',
      };
    }),
    settings.when,
  );
  const uploadingPending = pending.length;
  if (uploadingPending && schedule.disabledReason === 'Add videos first') {
    schedule.disabledReason = 'Uploading…';
  }

  const counts = { drafts: 0, processing: 0, attention: 0, scheduled: 0, published: 0 };
  for (const m of models.values()) {
    if (m.status === 'draft') counts.drafts += 1;
    else if (m.status === 'processing' || m.status === 'publishing') counts.processing += 1;
    else if (m.status === 'needs_attention') counts.attention += 1;
    else if (m.status === 'scheduled') counts.scheduled += 1;
    else if (m.status === 'published') counts.published += 1;
  }
  counts.processing += uploadingPending;
  const total = items.length + uploadingPending;

  const onSchedule = async () => {
    const id = batchIdRef.current;
    if (!id || schedule.readyPostIds.length === 0) return;
    setScheduling(true);
    const when = settings.when;
    const res = await scheduleBatchAction({ batchId: id, postIds: schedule.readyPostIds, when });
    setScheduling(false);
    if (!res.ok) {
      toast(res.error, 'error');
      return;
    }
    setSavedWhen(when);
    const s = res.summary;
    const draftMode = when.mode === 'draft';
    const done = s.scheduled.length;
    const head = draftMode
      ? `Saved ${done} draft${done === 1 ? '' : 's'}`
      : `Scheduled ${done} video${done === 1 ? '' : 's'}`;
    const skipped = s.skipped.length
      ? ` · ${s.skipped.length} skipped (${s.skipped[0]!.filename}: ${s.skipped[0]!.reason}${s.skipped.length > 1 ? ', …' : ''})`
      : '';
    const warn = s.warnings.length ? ` · ${s.warnings[0]}` : '';
    toast(`${head}${skipped}${warn}`, s.skipped.length ? 'error' : 'ok');
    setResult({ summary: s, draftMode });
    await refresh();
  };

  const closeEditor = useCallback(() => setEditing(null), []);
  const onEditorChanged = useCallback(() => void refresh(), [refresh]);

  return (
    <div className="space-y-4 pb-32">
      <DropOverlay visible={dragging} />
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Upload</h1>
        {batchId ? (
          <Link href="/" className="text-sm text-accent hover:underline">
            Start a new batch
          </Link>
        ) : null}
      </div>

      <DropZone compact={total > 0} disabled={!session} onFiles={(f) => void addFiles(f)} />

      <BatchBar
        settings={settings}
        onChange={setSettings}
        accounts={initial.accounts}
        today={initial.today}
        cardCount={items.length}
        dirty={barDirty}
        onApply={openApply}
        applying={applying}
      />

      {result ? (
        <ScheduleResultPanel
          summary={result.summary}
          timezone={tz}
          draftMode={result.draftMode}
          onDismiss={() => setResult(null)}
        />
      ) : null}

      {total > 0 ? (
        <section aria-label="Videos" className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-muted" aria-live="polite">
              <span className="font-medium text-text">
                {total} video{total === 1 ? '' : 's'}
              </span>
              {counts.drafts ? ` · ${counts.drafts} draft${counts.drafts === 1 ? '' : 's'}` : ''}
              {counts.processing ? ` · ${counts.processing} processing` : ''}
              {counts.scheduled ? ` · ${counts.scheduled} scheduled` : ''}
              {counts.published ? ` · ${counts.published} published` : ''}
              {counts.attention ? (
                <span className="text-danger"> · {counts.attention} need attention</span>
              ) : null}
            </p>
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted">Order</span>
              <select
                className="h-8 rounded-lg border border-border bg-surface px-2 text-sm"
                value={order}
                onChange={(e) => changeOrder(e.target.value as OrderMode)}
                disabled={items.length < 2}
              >
                {(['name', 'selection', 'added'] as const).map((m) => (
                  <option key={m} value={m}>
                    {ORDER_LABELS[m]}
                  </option>
                ))}
                {order === 'custom' ? <option value="custom">{ORDER_LABELS.custom}</option> : null}
              </select>
            </label>
          </div>

          <CardList
            items={items}
            keyOf={(i) => i.assetId}
            labelOf={(i) => i.filename}
            canReorder={() => items.length > 1}
            onReorder={(ids) => {
              setOrder('custom');
              void persistOrder(ids);
            }}
            renderCard={(item, drag) => {
              const model = models.get(item.assetId)!;
              const post = item.post;
              return (
                <AssetCard
                  filename={item.filename}
                  sizeBytes={item.sizeBytes}
                  model={model}
                  post={post}
                  timezone={tz}
                  pickMode={settings.when.mode === 'pick'}
                  dragHandle={drag.handle}
                  dragging={drag.dragging}
                  onEdit={post ? () => setEditing(post.id) : undefined}
                  onRetryUpload={() => session?.queue.retry(item.assetId)}
                  onCancelUpload={() => void removeAsset(item.assetId)}
                  onRemove={() => void removeAsset(item.assetId)}
                  onReselect={(file) => void reselect(item.assetId, file)}
                  onRetryProcessing={() => void retryProcessing(item.assetId)}
                  onPickTime={post ? (at) => pickTime(post.id, at) : undefined}
                />
              );
            }}
          />
          {pending.length ? (
            <ul className="space-y-2" aria-label="Preparing uploads">
              {pending.map((p) => (
                <li key={p.local.localKey}>
                  <AssetCard
                    filename={p.name}
                    sizeBytes={p.size}
                    model={buildCardModel(null, undefined, snap.probes[p.local.localKey])}
                    post={null}
                    timezone={tz}
                    pickMode={false}
                    dragHandle={<span className="-ml-1 w-6 shrink-0" aria-hidden />}
                  />
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : (
        <p className="px-1 text-sm text-muted">
          Your earlier videos are in the{' '}
          <Link href="/calendar" className="text-accent hover:underline">
            Calendar
          </Link>{' '}
          (List view).
        </p>
      )}

      <ScheduleFooter
        state={schedule}
        whenText={describeWhen(settings.when, tz)}
        busy={scheduling}
        onSchedule={() => void onSchedule()}
      />

      <ApplyDialog
        open={applyPlan !== null}
        plan={applyPlan}
        timezone={tz}
        rewriteReady={rewriteReady}
        onRewriteReadyChange={setRewriteReady}
        loading={applying}
        onConfirm={() => void confirmApply()}
        onCancel={closeApply}
      />

      <PostEditorDrawer postId={editing} onClose={closeEditor} onChanged={onEditorChanged} />
    </div>
  );
}
