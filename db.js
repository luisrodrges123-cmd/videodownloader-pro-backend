
import pg from "pg";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 10000
});

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS downloads (
      id BIGSERIAL PRIMARY KEY,
      platform VARCHAR(30) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS downloads_created_at_idx
    ON downloads(created_at)
  `);
}

