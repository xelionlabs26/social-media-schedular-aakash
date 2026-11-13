import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

export * from './schema';
export { schema };

export type Db = NodePgDatabase<typeof schema>;

let pool: pg.Pool | undefined;
let db: Db | undefined;

/**
 * Shared connection pool + Drizzle instance (one per process).
 * Reads DATABASE_URL unless a connection string is passed.
 */
export function getDb(connectionString = process.env.DATABASE_URL): Db {
  if (db) return db;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
  }
  pool = new pg.Pool({ connectionString, max: Number(process.env.DB_POOL_MAX ?? 10) });
  db = drizzle(pool, { schema, casing: 'snake_case' });
  return db;
}

export function getPool(): pg.Pool {
  if (!pool) getDb();
  return pool!;
}

export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = undefined;
  db = undefined;
}
