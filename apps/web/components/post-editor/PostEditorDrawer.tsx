'use client';

/**
 * Post editor drawer (PLAN.md §3.6). Opened from any card on Upload or Calendar.
 * (Module owner: ui-upload. This placeholder keeps the import contract stable.)
 */
import { Drawer } from '@/components/ui/drawer';

export interface PostEditorDrawerProps {
  /** Post to edit; null = closed. */
  postId: string | null;
  onClose: () => void;
  /** Called after any change is saved so the parent list can refresh. */
  onChanged?: () => void;
}

export function PostEditorDrawer({ postId, onClose }: PostEditorDrawerProps) {
  return (
    <Drawer open={postId !== null} onClose={onClose} title="Edit post">
      <div className="p-4 text-sm text-muted">Editor coming soon.</div>
    </Drawer>
  );
}
