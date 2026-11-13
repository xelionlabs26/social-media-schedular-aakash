/**
 * Calendar screen (PLAN.md §3.1, §3.4–3.6): Week | Month | List in the app time zone, with the
 * needs-attention banner and the drafts tray. URL state: ?view=week|month|list&date=YYYY-MM-DD
 * (&status=&q= for the list, &post=<id> opens the editor).
 */
import { z } from 'zod';
import { requireOwnerPage } from '@/lib/auth';
import { getDeps } from '@/lib/deps';
import { CalendarClient } from '@/components/calendar/CalendarClient';
import { isLocalDate, parseView } from '@/components/calendar/calendar-math';
import { loadCalendarData } from '@/components/calendar/data';
import { parseListFilter, parseQuery } from '@/components/calendar/list-filter';

export const metadata = { title: 'Calendar' };

type SearchParams = Record<string, string | string[] | undefined>;

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await requireOwnerPage();
  const sp = await searchParams;
  const view = parseView(sp.view);
  const rawDate = first(sp.date);
  const data = await loadCalendarData(getDeps(), {
    view,
    date: isLocalDate(rawDate) ? rawDate : null,
    filter: view === 'list' ? parseListFilter(sp.status) : null,
    query: view === 'list' ? parseQuery(sp.q) : '',
  });
  const post = first(sp.post);
  const initialPostId = post && z.uuid().safeParse(post).success ? post : null;
  // key: a new URL (view/date) gives fresh client state (closed menus, no stale drag).
  return (
    <CalendarClient key={`${data.view}:${data.date}`} data={data} initialPostId={initialPostId} />
  );
}
