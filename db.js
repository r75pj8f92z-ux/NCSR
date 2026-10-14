// Postgres access. One pool per instance; every query is parameterised ($1, $2 ...), never string-built.
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set. See .env.example.');

const local = /localhost|127\.0\.0\.1|\[::1\]/.test(url);
export const pool = new pg.Pool({
  connectionString: url,
  max: Number(process.env.DATABASE_POOL_MAX) || 5,
  ssl: local ? false : { rejectUnauthorized: true },
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 8000,
});
pool.on('error', (err) => console.error('Postgres pool error:', err.code || err.message));

export const exec = (text, params = []) => pool.query(text, params);
export const q = async (text, params = []) => (await pool.query(text, params)).rows;
export const one = async (text, params = []) => (await pool.query(text, params)).rows[0] ?? null;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
     id BIGSERIAL PRIMARY KEY,
     email TEXT NOT NULL UNIQUE,
     password_hash TEXT NOT NULL,
     display_name TEXT NOT NULL,
     tier TEXT NOT NULL DEFAULT 'free' CHECK (tier IN ('free', 'insider', 'elite')),
     stripe_customer_id TEXT,
     stripe_subscription_id TEXT,
     created_at BIGINT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_users_stripe_customer ON users (stripe_customer_id)`,
  `CREATE TABLE IF NOT EXISTS sessions (
     token_hash TEXT PRIMARY KEY,
     user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
     expires_at BIGINT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id)`,
  `CREATE TABLE IF NOT EXISTS topics (
     id BIGSERIAL PRIMARY KEY,
     user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
     program_id TEXT,
     title TEXT NOT NULL,
     body TEXT NOT NULL,
     created_at BIGINT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_topics_created ON topics (created_at)`,
  `CREATE TABLE IF NOT EXISTS replies (
     id BIGSERIAL PRIMARY KEY,
     topic_id BIGINT NOT NULL REFERENCES topics (id) ON DELETE CASCADE,
     user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
     body TEXT NOT NULL,
     created_at BIGINT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_replies_topic ON replies (topic_id)`,
  `CREATE INDEX IF NOT EXISTS idx_replies_created ON replies (created_at)`,
  `CREATE TABLE IF NOT EXISTS auth_attempts (
     ip TEXT NOT NULL,
     at BIGINT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_auth_attempts_ip ON auth_attempts (ip, at)`,
  `CREATE TABLE IF NOT EXISTS password_resets (
     token_hash TEXT PRIMARY KEY,
     user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
     expires_at BIGINT NOT NULL,
     used BOOLEAN NOT NULL DEFAULT FALSE
   )`,
];

let migrated = null;

// Creates tables on first use in each instance. Safe to run repeatedly.
export function ensureDb() {
  migrated ??= (async () => {
    for (const statement of SCHEMA) await pool.query(statement);
    await pool.query('DELETE FROM sessions WHERE expires_at < $1', [Date.now()]);
  })().catch((err) => {
    migrated = null;
    throw err;
  });
  return migrated;
}
