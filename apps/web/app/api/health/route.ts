import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { getDeps } from '@/lib/deps';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await getDeps().db.execute(sql`select 1`);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false }, { status: 503 });
  }
}
