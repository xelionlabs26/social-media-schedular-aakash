'use client';

/**
 * Left column of the editor: the video (preview only, no editing in v1), length and shape, and
 * the editable Transcript and Notes with "Rewrite all texts".
 */
import { useId } from 'react';
import { Badge } from '@/components/ui/badges';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/field';
import { FilmIcon } from '@/components/upload/icons';
import { NOTES_MAX_CHARS, TRANSCRIPT_MAX_CHARS } from '@/lib/upload/constants';
import { formatDuration, shapeLabel } from '@/lib/upload/format';
import type { EditorData } from '@/lib/upload/types';

export function VideoPane({
  data,
  transcript,
  notes,
  textsChanged,
  saving,
  rewriting,
  writing,
  onTranscript,
  onNotes,
  onBlurTexts,
  onRewrite,
}: {
  data: EditorData;
  transcript: string;
  notes: string;
  /** Transcript or notes differ from what the current texts were written from. */
  textsChanged: boolean;
  saving: boolean;
  rewriting: boolean;
  /** The AI is writing right now. */
  writing: boolean;
  onTranscript: (v: string) => void;
  onNotes: (v: string) => void;
  onBlurTexts: () => void;
  onRewrite: () => void;
}) {
  const id = useId();
  const { asset } = data.card;
  const shape = shapeLabel(asset.width, asset.height);
  const ready = asset.status === 'ready';
  return (
    <div className="space-y-3">
      {data.videoUrl ? (
        <video
          src={data.videoUrl}
          controls
          playsInline
          preload="metadata"
          aria-label={`Preview of ${asset.filename}`}
          className="mx-auto max-h-[42vh] w-full rounded-lg bg-black object-contain md:max-h-[58vh]"
        />
      ) : (
        <div className="flex aspect-[9/16] max-h-[42vh] w-full flex-col items-center justify-center gap-2 rounded-lg bg-surface-2 text-center text-xs text-muted">
          <FilmIcon className="h-8 w-8" />
          {asset.status === 'uploading' ? 'Still uploading' : 'Preview not available'}
        </div>
      )}
      <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <span>{formatDuration(asset.durationMs)}</span>
        {shape ? <Badge>{shape}</Badge> : null}
        {data.videoSource === 'original' && ready ? <span>original file</span> : null}
      </p>

      <details className="group rounded-lg border border-border" open={!asset.transcript}>
        <summary className="cursor-pointer px-3 py-2 text-sm font-medium select-none">
          Transcript
          {data.transcriptEdited ? (
            <span className="ml-1 text-xs font-normal text-muted">(edited)</span>
          ) : null}
        </summary>
        <div className="space-y-1 px-3 pb-3">
          <label htmlFor={`${id}-transcript`} className="sr-only">
            Transcript
          </label>
          <Textarea
            id={`${id}-transcript`}
            rows={6}
            maxLength={TRANSCRIPT_MAX_CHARS}
            value={transcript}
            placeholder={
              ready ? 'No speech found. Add what is said, if anything.' : 'Transcribing…'
            }
            onChange={(e) => onTranscript(e.target.value)}
            onBlur={onBlurTexts}
          />
          <p className="text-[11px] text-muted">Fix names or words the speech-to-text got wrong.</p>
        </div>
      </details>

      <details className="rounded-lg border border-border" open={Boolean(notes)}>
        <summary className="cursor-pointer px-3 py-2 text-sm font-medium select-none">
          Notes for AI
        </summary>
        <div className="space-y-1 px-3 pb-3">
          <label htmlFor={`${id}-notes`} className="sr-only">
            Notes for AI
          </label>
          <Textarea
            id={`${id}-notes`}
            rows={3}
            maxLength={NOTES_MAX_CHARS}
            value={notes}
            placeholder="Names, places, what the video is about"
            onChange={(e) => onNotes(e.target.value)}
            onBlur={onBlurTexts}
          />
        </div>
      </details>

      <div className="space-y-1">
        <Button
          className="w-full"
          size="sm"
          variant={textsChanged ? 'primary' : 'secondary'}
          loading={rewriting}
          disabled={!ready || writing}
          onClick={onRewrite}
        >
          Rewrite all texts
        </Button>
        <p className="text-[11px] text-muted" aria-live="polite">
          {writing
            ? 'Writing captions…'
            : saving
              ? 'Saving…'
              : textsChanged
                ? 'Transcript or notes changed. Rewrite to use them (text you typed yourself is kept).'
                : 'Uses the transcript and notes above.'}
        </p>
      </div>
    </div>
  );
}
