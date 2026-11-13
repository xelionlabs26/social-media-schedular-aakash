/**
 * Which cards the footer's "Schedule N videos" button will send, and why it is disabled when
 * none can go (PLAN.md §3.10: "Schedule button disabled with a reason"). Pure and client-safe.
 */
import { PLATFORM_LABELS } from '@app/core/platforms';
import type { PostCard } from '@app/core/posts';
import type { WhenRule } from './types';

export interface ReadinessItem {
  assetId: string;
  filename: string;
  post: PostCard | null;
  /** The browser is still sending this file. */
  uploading: boolean;
}

export interface ScheduleState {
  /** Posts the button will send, in card order. */
  readyPostIds: string[];
  /** Cards left out because they need a fix first. */
  needsAttention: Array<{ assetId: string; filename: string; reason: string }>;
  uploading: number;
  processing: number;
  /** Cards with no draft left (already scheduled or published). */
  done: number;
  /** null = the button is enabled. */
  disabledReason: string | null;
  buttonLabel: string;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function computeScheduleState(items: ReadinessItem[], when: WhenRule): ScheduleState {
  const state: ScheduleState = {
    readyPostIds: [],
    needsAttention: [],
    uploading: 0,
    processing: 0,
    done: 0,
    disabledReason: null,
    buttonLabel: '',
  };
  let writing = false;

  for (const item of items) {
    const { post } = item;
    if (!post) {
      if (item.uploading) state.uploading += 1;
      else
        state.needsAttention.push({
          assetId: item.assetId,
          filename: item.filename,
          reason: 'Upload interrupted',
        });
      continue;
    }
    if (post.asset.status === 'failed') {
      state.needsAttention.push({
        assetId: item.assetId,
        filename: item.filename,
        reason: post.asset.error ? `Processing failed: ${post.asset.error}` : 'Processing failed',
      });
      continue;
    }
    if (post.asset.status !== 'ready') {
      state.processing += 1;
      if (post.asset.processingStep === 'generate') writing = true;
      continue;
    }
    const drafts = post.targets.filter((t) => t.status === 'draft');
    if (drafts.length === 0) {
      const attention = post.targets.find((t) => t.display === 'needs_attention');
      if (attention) {
        state.needsAttention.push({
          assetId: item.assetId,
          filename: item.filename,
          reason: `${PLATFORM_LABELS[attention.platform]}: ${attention.attention ?? 'needs attention'}`,
        });
      } else {
        state.done += 1;
      }
      continue;
    }
    const blocking = drafts.flatMap((t) =>
      t.issues
        .filter((i) => i.severity === 'block')
        .map((i) => `${PLATFORM_LABELS[t.platform]}: ${i.message}`),
    );
    if (blocking.length) {
      state.needsAttention.push({
        assetId: item.assetId,
        filename: item.filename,
        reason: blocking[0]!,
      });
      continue;
    }
    state.readyPostIds.push(post.id);
  }

  const n = state.readyPostIds.length;
  state.buttonLabel =
    when.mode === 'draft' ? `Save ${plural(n, 'draft')}` : `Schedule ${plural(n, 'video')}`;
  if (n === 0) {
    if (items.length === 0) state.disabledReason = 'Add videos first';
    else if (state.uploading) state.disabledReason = 'Uploading…';
    else if (state.processing)
      state.disabledReason = writing ? 'Writing captions…' : 'Analyzing videos…';
    else if (state.needsAttention.length)
      state.disabledReason = 'Fix the cards that need attention';
    else if (state.done) state.disabledReason = 'Everything here is scheduled';
    else state.disabledReason = 'Nothing to schedule';
  }
  return state;
}
