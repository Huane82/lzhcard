import pg from 'pg';

const { Pool } = pg;

export function createPgPool(): pg.Pool {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (connectionString) {
    return new Pool({
      connectionString,
      max: Number(process.env.PG_POOL_MAX || 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000
    });
  }

  const host = process.env.POSTGRES_HOST?.trim() || '127.0.0.1';
  const port = Number(process.env.POSTGRES_PORT || 5432);
  const database = process.env.POSTGRES_DB?.trim() || 'lzhcard';
  const user = process.env.POSTGRES_USER?.trim();
  const password = process.env.POSTGRES_PASSWORD;

  if (!user || !password) {
    throw new Error(
      'Missing PostgreSQL credentials: set DATABASE_URL or POSTGRES_USER + POSTGRES_PASSWORD in environment.'
    );
  }

  return new Pool({
    host,
    port,
    database,
    user,
    password,
    max: Number(process.env.PG_POOL_MAX || 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000
  });
}
