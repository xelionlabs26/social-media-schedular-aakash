'use client';

/**
 * Privacy gate (PLAN.md §9): YouTube's policy requires the user to agree to the privacy policy
 * before first use. Shown at the top of every app page until [I agree] is clicked.
 */
import Link from 'next/link';
import { acceptPrivacyAction } from '@/lib/actions/settings';
import { Button } from '@/components/ui/button';
import { useSettingsAction } from './parts';

export function PrivacyBanner() {
  const { pending, run } = useSettingsAction();
  return (
    <div role="region" aria-label="Privacy policy" className="border-b border-warn/40 bg-warn/10">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 text-sm sm:px-6">
        <p className="min-w-0 flex-1">
          <span aria-hidden className="font-bold text-warn">
            !{' '}
          </span>
          Before first use, please agree to the{' '}
          <Link href="/privacy" target="_blank" className="font-medium text-accent underline">
            Privacy Policy
          </Link>{' '}
          (it also covers how YouTube data is used).
        </p>
        <Button
          size="sm"
          variant="primary"
          loading={pending}
          onClick={() => run(acceptPrivacyAction)}
        >
          I agree
        </Button>
      </div>
    </div>
  );
}
