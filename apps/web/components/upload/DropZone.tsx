'use client';

/**
 * "Drop videos here or [Choose files]" plus a full-page drop target: files can be dropped
 * anywhere on the screen (PLAN.md §3.10, from Publer).
 */
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { FILE_INPUT_ACCEPT } from '@/lib/upload/constants';
import { UploadIcon } from './icons';

const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');

/** Window-level drag & drop. Returns whether files are being dragged over the page. */
export function useWindowFileDrop(enabled: boolean, onFiles: (files: File[]) => void): boolean {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const onFilesRef = useRef(onFiles);
  useEffect(() => {
    onFilesRef.current = onFiles;
  }, [onFiles]);

  useEffect(() => {
    if (!enabled) return;
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current += 1;
      setDragging(true);
    };
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      // Required for the browser to allow a drop.
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length) onFilesRef.current(files);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
      depth.current = 0;
      setDragging(false);
    };
  }, [enabled]);

  return enabled && dragging;
}

export function DropOverlay({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <div
      className="pointer-events-none fixed inset-0 z-[55] flex items-center justify-center bg-accent/10 p-6"
      aria-hidden
    >
      <div className="flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-accent bg-surface px-10 py-8 text-center shadow-xl">
        <UploadIcon className="h-8 w-8 text-accent" />
        <p className="text-base font-semibold">Drop videos to upload</p>
        <p className="text-sm text-muted">MP4 or MOV, as many as you like</p>
      </div>
    </div>
  );
}

export function DropZone({
  compact,
  disabled,
  onFiles,
}: {
  /** Smaller once cards exist. */
  compact: boolean;
  disabled?: boolean;
  onFiles: (files: File[]) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <section
      aria-label="Add videos"
      className={cn(
        'flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border bg-surface text-center',
        compact ? 'px-4 py-4 sm:flex-row sm:gap-3' : 'px-4 py-10 sm:py-14',
      )}
    >
      {!compact ? <UploadIcon className="h-8 w-8 text-muted" /> : null}
      <p className={cn('text-sm', compact ? 'text-muted' : 'text-base font-medium')}>
        Drop videos here <span className="text-muted">or</span>
      </p>
      <Button
        variant={compact ? 'secondary' : 'primary'}
        size={compact ? 'sm' : 'md'}
        onClick={() => input.current?.click()}
        disabled={disabled}
      >
        Choose files
      </Button>
      <p id="dropzone-hint" className="text-xs text-muted">
        MP4/MOV, many at once, up to 2 GB each
      </p>
      <input
        ref={input}
        type="file"
        multiple
        accept={FILE_INPUT_ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (files.length) onFiles(files);
        }}
      />
    </section>
  );
}
