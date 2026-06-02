import { pool } from './index';

export async function migrate(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS reporters (
        id              SERIAL PRIMARY KEY,
        name            TEXT    NOT NULL,
        city            TEXT    NOT NULL,
        is_available    BOOLEAN NOT NULL DEFAULT TRUE,
        rate_per_minute INTEGER NOT NULL DEFAULT 2000,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS editors (
        id         SERIAL PRIMARY KEY,
        name       TEXT    NOT NULL,
        flat_fee   INTEGER NOT NULL DEFAULT 50000,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS jobs (
        id            SERIAL PRIMARY KEY,
        case_name     TEXT    NOT NULL,
        duration      INTEGER NOT NULL,
        location_type TEXT    NOT NULL CHECK (location_type IN ('physical','remote')),
        city          TEXT,
        status        TEXT    NOT NULL DEFAULT 'NEW'
                      CHECK (status IN ('NEW','ASSIGNED','TRANSCRIBED','REVIEWED','COMPLETED')),
        reporter_id   INTEGER REFERENCES reporters(id),
        editor_id     INTEGER REFERENCES editors(id),
        transcript    TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS transcript TEXT;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id               SERIAL PRIMARY KEY,
        job_id           INTEGER NOT NULL REFERENCES jobs(id),
        reporter_payout  INTEGER NOT NULL,
        editor_payout    INTEGER NOT NULL,
        total_payout     INTEGER NOT NULL,
        rate_per_minute  INTEGER NOT NULL,
        calculated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION update_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
      $$ LANGUAGE plpgsql;
    `);

    await client.query(`
      DROP TRIGGER IF EXISTS trg_jobs_updated_at ON jobs;
      CREATE TRIGGER trg_jobs_updated_at
        BEFORE UPDATE ON jobs
        FOR EACH ROW EXECUTE FUNCTION update_updated_at();
    `);

    await client.query('COMMIT');
    console.log('✅ Database migrated successfully');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
