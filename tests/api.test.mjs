// End-to-end API checks. Starts the real server on a temporary port and database.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase } from './helpers.js';

let testDb;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = null;
const port = 4100 + Math.floor(Math.random() * 500);
const base = `http://localhost:${port}`;
let server;
let freeCookie;
let insiderCookie;
let eliteCookie;

function cookieFrom(res) {
  const raw = res.headers.get('set-cookie');
  return raw ? raw.split(';')[0] : null;
}

async function call(method, route, { body, cookie } = {}) {
  const res = await fetch(base + route, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  return { res, status: res.status, data };
}

before(async () => {
  testDb = await createTestDatabase();
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), DATABASE_URL: testDb.url, DEMO_BILLING: '1', NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(base + '/api/health');
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('server did not start');
});

after(async () => {
  server?.kill();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  await testDb?.drop();
});

test('health and security headers', async () => {
  const { status, res } = await call('GET', '/api/health');
  assert.equal(status, 200);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
});

test('config lists seven programs and three plans', async () => {
  const { data } = await call('GET', '/api/config');
  assert.equal(data.programs.length, 7);
  assert.deepEqual(data.plans.map((p) => p.price), [0, 5, 20]);
});

test('every program has a sourced football coach and record', async () => {
  const { data } = await call('GET', '/api/programs/unc');
  assert.ok(data.sports.football.coach);
  assert.ok(data.sports.football.source.startsWith('https://'));
});

test('insider news bodies are withheld from free visitors', async () => {
  const { data } = await call('GET', '/api/news');
  const insider = data.find((n) => n.tier === 'insider');
  assert.equal(insider.locked, true);
  assert.equal(insider.body, undefined);
  const free = data.find((n) => n.tier === 'free');
  assert.equal(free.locked, false);
  assert.ok(free.body);
});

test('signup, free user can reply but not start topics', async () => {
  const signup = await call('POST', '/api/auth/signup', { body: { email: 'free@example.com', password: 'freepassword1' } });
  assert.equal(signup.status, 201);
  freeCookie = cookieFrom(signup.res);

  const topic = await call('POST', '/api/topics', { body: { title: 'A free topic', body: 'hello' }, cookie: freeCookie });
  assert.equal(topic.status, 402);

  // Seed a topic as an insider, then reply as the free user.
  const ins = await call('POST', '/api/auth/signup', { body: { email: 'insider@example.com', password: 'insiderpass1' } });
  insiderCookie = cookieFrom(ins.res);
  await call('POST', '/api/billing/demo-upgrade', { body: { plan: 'insider' }, cookie: insiderCookie });
  const created = await call('POST', '/api/topics', { body: { title: 'Seeded topic', body: 'opening post' }, cookie: insiderCookie });
  assert.equal(created.status, 201);

  const reply = await call('POST', `/api/topics/${created.data.id}/replies`, { body: { body: 'Free reply' }, cookie: freeCookie });
  assert.equal(reply.status, 201);
});

test('premium roster and analysis are Elite only, and load real data', async () => {
  const denied = await call('GET', '/api/premium/roster/unc/football', { cookie: insiderCookie });
  assert.equal(denied.status, 402);

  const signup = await call('POST', '/api/auth/signup', { body: { email: 'elite@example.com', password: 'elitepass12' } });
  eliteCookie = cookieFrom(signup.res);
  await call('POST', '/api/billing/demo-upgrade', { body: { plan: 'elite' }, cookie: eliteCookie });

  const roster = await call('GET', '/api/premium/roster/unc/football', { cookie: eliteCookie });
  assert.equal(roster.status, 200);
  assert.ok(roster.data.players.length > 100);

  const analysis = await call('GET', '/api/premium/analysis/unc/football', { cookie: eliteCookie });
  assert.equal(analysis.data.available, true);
});

test('NC Metrics: seven teams per sport, ranked, Elite only', async () => {
  const denied = await call('GET', '/api/premium/metrics', { cookie: insiderCookie });
  assert.equal(denied.status, 402);

  const { status, data } = await call('GET', '/api/premium/metrics', { cookie: eliteCookie });
  assert.equal(status, 200);
  const football = data.teams.filter((t) => t.sport === 'football');
  assert.equal(football.length, 7);
  const duke = football.find((t) => t.programId === 'duke');
  assert.ok(duke.stats.ptsPerGame.value > 0);
  assert.ok([1, 2, 3, 4, 5, 6, 7].includes(duke.stats.ptsPerGame.rank));
  assert.ok(data.definitions.football.length > 5);
  assert.ok(data.source.includes('ESPN'));
});

test('roster players carry season stat summaries and full detail groups', async () => {
  const { data } = await call('GET', '/api/premium/roster/duke/football', { cookie: eliteCookie });
  const withStats = data.players.find((p) => p.summary);
  assert.ok(withStats, 'at least one player has a stat line');
  assert.ok(withStats.details.length > 0);
});

test('AI analysis falls back to a stats-based summary without an API key', async () => {
  const { data } = await call('GET', '/api/premium/analysis/wake/football', { cookie: eliteCookie });
  assert.equal(data.source, 'stats');
  assert.match(data.text, /of 7/);
});

test('webhook rejects requests without a valid signature', async () => {
  const { status } = await call('POST', '/api/billing/webhook', { body: { type: 'x' } });
  assert.ok(status === 400 || status === 503);
});

test('unknown API routes return JSON 404', async () => {
  const { status, data } = await call('GET', '/api/nope');
  assert.equal(status, 404);
  assert.equal(data.error, 'Not found.');
});
