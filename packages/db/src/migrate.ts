import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { closeDb, getDb } from './index';
import { appSettings } from './schema';

/** Applies SQL migrations from ./drizzle and makes sure the settings row exists. */
export async function runMigrations(connectionString = process.env.DATABASE_URL): Promise<void> {
  const db = getDb(connectionString);
  const here = path.dirname(fileURLToPath(import.meta.url));
  await migrate(db, { migrationsFolder: path.join(here, '..', 'drizzle') });
  await db.insert(appSettings).values({ id: 1 }).onConflictDoNothing();
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  runMigrations()
    .then(async () => {
      console.log('Database is up to date.');
      await closeDb();
    })
    .catch(async (err) => {
      console.error(err);
      await closeDb();
      process.exit(1);
    });
}
