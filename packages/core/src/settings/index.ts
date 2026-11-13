import { eq } from 'drizzle-orm';
import { appSettings, type AppSettings, type Db } from '@app/db';

/** Reads the single settings row, creating it with defaults if missing. */
export async function getSettings(db: Db): Promise<AppSettings> {
  const rows = await db.select().from(appSettings).where(eq(appSettings.id, 1)).limit(1);
  if (rows[0]) return rows[0];
  await db.insert(appSettings).values({ id: 1 }).onConflictDoNothing();
  const again = await db.select().from(appSettings).where(eq(appSettings.id, 1)).limit(1);
  return again[0]!;
}

export async function updateSettings(
  db: Db,
  patch: Partial<Omit<AppSettings, 'id' | 'createdAt' | 'updatedAt'>>,
): Promise<AppSettings> {
  await getSettings(db);
  const rows = await db.update(appSettings).set(patch).where(eq(appSettings.id, 1)).returning();
  return rows[0]!;
}
