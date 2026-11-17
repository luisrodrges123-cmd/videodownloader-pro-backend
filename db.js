
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS download_ownership (
      id BIGSERIAL PRIMARY KEY,
      provider_download_id TEXT UNIQUE NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      is_paid BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS mp_webhook_events (
      id BIGSERIAL PRIMARY KEY,
      event_key TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_events (
      id BIGSERIAL PRIMARY KEY,
      event_type VARCHAR(50) NOT NULL,
      category VARCHAR(20) NOT NULL,
      user_id INTEGER,
      username VARCHAR(80),
      details TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS admin_events_created_at_idx ON admin_events(created_at DESC);
    CREATE INDEX IF NOT EXISTS admin_events_category_created_at_idx ON admin_events(category, created_at DESC);

    CREATE TABLE IF NOT EXISTS admin_bot_settings (
      singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton = TRUE),
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      alert_users BOOLEAN NOT NULL DEFAULT TRUE,
      alert_downloads BOOLEAN NOT NULL DEFAULT TRUE,
      alert_premium BOOLEAN NOT NULL DEFAULT TRUE,
      alert_payments BOOLEAN NOT NULL DEFAULT TRUE,
      alert_security BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    INSERT INTO admin_bot_settings (singleton)
    VALUES (TRUE)
    ON CONFLICT (singleton) DO NOTHING;

    CREATE TABLE IF NOT EXISTS admin_alert_outbox (
      id BIGSERIAL PRIMARY KEY,
      event_id BIGINT NOT NULL UNIQUE REFERENCES admin_events(id) ON DELETE CASCADE,
      state VARCHAR(20) NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_attempt_at TIMESTAMPTZ,
      sent_at TIMESTAMPTZ,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS admin_alert_outbox_due_idx ON admin_alert_outbox(state, next_attempt_at);
  `);
}

