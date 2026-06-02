import 'dotenv/config';
import { Pool } from 'pg';

export const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     Number(process.env.DB_PORT) || 5432,
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME     || 'voicescript',
});

/** Test connectivity on startup */
export async function testConnection(): Promise<void> {
  const client = await pool.connect();
  client.release();
  console.log('✅ PostgreSQL connected');
}

/**
 * Run a SELECT query and return all rows.
 * Uses parameterised queries — safe from SQL injection.
 */
export async function queryAll<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const { rows } = await pool.query(sql, params);
  return rows as T[];
}

/** Run a SELECT query and return the first row, or null. */
export async function queryOne<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T | null> {
  const rows = await queryAll<T>(sql, params);
  return rows[0] ?? null;
}

/** Run an INSERT/UPDATE/DELETE. Returns rowCount. */
export async function execute(
  sql: string,
  params: unknown[] = []
): Promise<number> {
  const result = await pool.query(sql, params);
  return result.rowCount ?? 0;
}
