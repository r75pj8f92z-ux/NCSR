// Security checks: sessions, password reset, rate limits, cross-site requests, cookies, webhooks, and error output.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createTestDatabase } from './helpers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let testDb, server, base, lastResetLink = null, dbUrl;

// Starts the real server and reads its console output, which holds the dev-mode reset link.
function startServer(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const onData = (chunk) => {
      output += chunk.toString();
      const match = output.match(/password reset link for [^:]+: (\S+)/);
      if (match) lastResetLink = match[1];
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
    const started = Date.now();
    (async function probe() {
      try {
        await fetch(base + '/api/health');
        resolve(child);
      } catch {
        if (Date.now() - started > 15000) return reject(new Error('server did not start'));
        setTimeout(probe, 150);
      }
    })();
  });
}

async function call(method, route, { body, cookie, headers = {} } = {}) {
  const res = await fetch(base + route, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, res };
}

before(async () => {
  testDb = await createTestDatabase();
  dbUrl = testDb.url;
  const port = 4900 + Math.floor(Math.random() * 300);
  base = `http://localhost:${port}`;
  server = await startServer({ PORT: String(port), DATABASE_URL: dbUrl, NODE_ENV: 'test', DEMO_BILLING: '', STRIPE_WEBHOOK_SECRET: 'whsec_security_test', AUTH_RATE_MAX: '40' });
});

after(async () => {
  server?.kill();
  await testDb?.drop();
});

const EMAIL = 'security-user@example.com';
const PASSWORD = 'original-password-1';
let cookie;

test('sign-up sets a session cookie that is HttpOnly and SameSite=Lax', async () => {
  const { status, res } = await call('POST', '/api/auth/signup', { body: { email: EMAIL, password: PASSWORD } });
  assert.equal(status, 201);
  const setCookie = res.headers.get('set-cookie');
  assert.match(setCookie, /nc_session=[a-f0-9]{64}/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Lax/i);
  cookie = setCookie.split(';')[0];
});

test('the database stores a hash of the session token, never the token itself', async () => {
  const token = cookie.split('=')[1];
  const c = new pg.Client({ connectionString: dbUrl });
  await c.connect();
  const rows = (await c.query('SELECT token_hash FROM sessions')).rows;
  await c.end();
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((r) => r.token_hash !== token), 'raw token is not stored');
  assert.ok(rows.some((r) => r.token_hash === crypto.createHash('sha256').update(token).digest('hex')));
});

test('passwords are stored with a salted scrypt hash, not in plain text', async () => {
  const c = new pg.Client({ connectionString: dbUrl });
  await c.connect();
  const row = (await c.query('SELECT password_hash FROM users WHERE email = $1', [EMAIL])).rows[0];
  await c.end();
  assert.ok(!row.password_hash.includes(PASSWORD));
  const [salt, hash] = row.password_hash.split(':');
  assert.equal(salt.length, 32);
  assert.equal(hash.length, 128);
});

test('login errors are identical for an unknown email and a wrong password', async () => {
  const unknown = await call('POST', '/api/auth/login', { body: { email: 'nobody@example.com', password: 'whatever-123' } });
  const wrong = await call('POST', '/api/auth/login', { body: { email: EMAIL, password: 'wrong-password-99' } });
  assert.equal(unknown.status, 401);
  assert.equal(wrong.status, 401);
  assert.equal(unknown.data.error, wrong.data.error);
});

test('signing up with an existing email gives a generic message that does not confirm the account', async () => {
  const { status, data } = await call('POST', '/api/auth/signup', { body: { email: EMAIL, password: PASSWORD } });
  assert.equal(status, 409);
  assert.match(data.error, /log in or reset your password/);
  assert.doesNotMatch(data.error, /already exists/);
});

test('the forgot-password answer is the same for real and unknown emails', async () => {
  const real = await call('POST', '/api/auth/forgot', { body: { email: EMAIL } });
  const fake = await call('POST', '/api/auth/forgot', { body: { email: 'not-a-user@example.com' } });
  assert.equal(real.status, 200);
  assert.equal(real.data.message, fake.data.message);
});

test('password reset: a valid link sets a new password once, signs out other sessions, and cannot be reused', async () => {
  // The reset link appears in the server log in development. Wait for it.
  for (let i = 0; i < 40 && !lastResetLink; i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(lastResetLink, 'reset link was issued');
  const token = new URL(lastResetLink.replace('/#/', '/')).searchParams.get('token');
  assert.match(token, /^[a-f0-9]{64}$/);

  const reset = await call('POST', '/api/auth/reset', { body: { token, password: 'brand-new-password-2' } });
  assert.equal(reset.status, 200);

  const oldLogin = await call('POST', '/api/auth/login', { body: { email: EMAIL, password: PASSWORD } });
  assert.equal(oldLogin.status, 401, 'old password no longer works');
  const newLogin = await call('POST', '/api/auth/login', { body: { email: EMAIL, password: 'brand-new-password-2' } });
  assert.equal(newLogin.status, 200);

  const oldSession = await call('GET', '/api/auth/me', { cookie });
  assert.equal(oldSession.data.user, null, 'sessions were signed out by the reset');

  const reused = await call('POST', '/api/auth/reset', { body: { token, password: 'another-password-3' } });
  assert.equal(reused.status, 400, 'a reset link works once');
});

test('reset rejects malformed tokens and short passwords', async () => {
  assert.equal((await call('POST', '/api/auth/reset', { body: { token: 'not-a-token', password: 'valid-password-1' } })).status, 400);
  assert.equal((await call('POST', '/api/auth/reset', { body: { token: 'a'.repeat(64), password: 'short' } })).status, 400);
});

test('cross-site state changes are refused', async () => {
  const blocked = await call('POST', '/api/topics', {
    body: { title: 'Cross site topic', body: 'x' },
    cookie,
    headers: { Origin: 'https://evil.example' },
  });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.error, 'Request blocked.');
});

test('same-origin requests with an Origin header still work', async () => {
  const { status } = await call('POST', '/api/auth/logout', { headers: { Origin: base } });
  assert.equal(status, 200);
});


test('the Stripe webhook refuses bodies without the exact signed bytes', async () => {
  const res = await call('POST', '/api/billing/webhook', {
    body: { id: 'evt_x', type: 'checkout.session.completed', data: { object: {} } },
    headers: { 'Stripe-Signature': 't=1,v1=00' },
  });
  assert.equal(res.status, 400);
});

test('stored discussion text is returned as data, not markup', async () => {
  const payload = '<img src=x onerror=alert(1)>';
  const insider = await call('POST', '/api/auth/signup', { body: { email: 'markup-test@example.com', password: 'markup-password-1' } });
  const c = insider.res.headers.get('set-cookie').split(';')[0];
  const c2 = new pg.Client({ connectionString: dbUrl });
  await c2.connect();
  await c2.query("UPDATE users SET tier = 'insider' WHERE email = 'markup-test@example.com'");
  await c2.end();
  const created = await call('POST', '/api/topics', { body: { title: 'Markup check topic', body: payload }, cookie: c });
  assert.equal(created.status, 201);
  assert.equal(created.data.body, payload, 'the text is stored exactly, and rendered as text by the page');
});

test('SQL in input is treated as text, not executed', async () => {
  const attack = "x'; DROP TABLE users; --@example.com";
  const res = await call('POST', '/api/auth/login', { body: { email: attack, password: 'anything-here-1' } });
  assert.equal(res.status, 401);
  const still = await call('POST', '/api/auth/signup', { body: { email: 'after-attack@example.com', password: 'after-attack-1' } });
  assert.equal(still.status, 201, 'the users table still exists');
});

test('error responses do not reveal stack traces or internal paths', async () => {
  const res = await call('POST', '/api/auth/login', { body: '{not json', headers: { 'Content-Type': 'application/json' } });
  assert.equal(res.status, 400);
  assert.doesNotMatch(JSON.stringify(res.data), /at |node_modules|\.js:/);
  const missing = await call('GET', '/api/does-not-exist');
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.data, { error: 'Not found.' });
});

test('the health check reports status without internal details', async () => {
  const { data } = await call('GET', '/api/health');
  assert.deepEqual(data, { ok: true });
});

// Kept last: it uses up the sign-in allowance for this test server.
test('the sign-in rate limit blocks repeated attempts with a 429', async () => {
  let last;
  for (let i = 0; i < 60; i++) {
    last = await call('POST', '/api/auth/login', { body: { email: 'limit@example.com', password: 'wrong-password-00' } });
    if (last.status === 429) break;
  }
  assert.equal(last.status, 429);
  assert.match(last.data.error, /Too many attempts/);
});
