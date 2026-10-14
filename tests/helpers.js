// Creates a throwaway Postgres database per test file, so tests never touch real data.
import crypto from 'node:crypto';
import pg from 'pg';

const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL || 'postgres://postgres:testpass@localhost:54329/postgres';

export async function createTestDatabase() {
  const name = `t_${crypto.randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = ADMIN_URL.replace(/\/[^/?]*(\?.*)?$/, `/${name}`);
  return {
    url,
    async drop() {
      const c = new pg.Client({ connectionString: ADMIN_URL });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}
