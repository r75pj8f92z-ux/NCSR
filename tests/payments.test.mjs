// Stripe billing and AI analysis, tested against local stand-ins. No real keys or network calls.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTestDatabase } from './helpers.js';

let testDb;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = null;
const WEBHOOK_SECRET = 'whsec_test_only';
const stripeCalls = [];
let aiCalls = 0;
let stripe, ai, server, base;
let userA, cookieA, userB, cookieB;

function listen(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sign(payload, secret = WEBHOOK_SECRET, ageSeconds = 0) {
  const t = Math.floor(Date.now() / 1000) - ageSeconds;
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

async function call(method, route, { body, cookie, headers = {} } = {}) {
  const res = await fetch(base + route, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  return { status: res.status, data, res };
}

async function postWebhook(event, signature) {
  const payload = JSON.stringify(event);
  return call('POST', '/api/billing/webhook', { body: payload, headers: { 'Stripe-Signature': signature ?? sign(payload) } });
}

async function signUp(email) {
  const { res, data } = await call('POST', '/api/auth/signup', { body: { email, password: 'paymentpass1' } });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return { user: data.user, cookie };
}

before(async () => {
  testDb = await createTestDatabase();
  stripe = await listen(async (req, res) => {
    const body = await readBody(req);
    stripeCalls.push({ url: req.url, body });
    if (req.url === '/v1/checkout/sessions') return sendJson(res, 200, { url: 'https://checkout.stripe.test/session_1' });
    if (req.url === '/v1/billing_portal/sessions') return sendJson(res, 200, { url: 'https://billing.stripe.test/portal_1' });
    sendJson(res, 404, { error: { message: 'not mocked' } });
  });
  ai = await listen(async (req, res) => {
    await readBody(req);
    aiCalls += 1;
    if (req.url === '/v1/messages') return sendJson(res, 200, { content: [{ type: 'text', text: 'Mock analysis text.' }] });
    sendJson(res, 404, {});
  });

  const port = 4700 + Math.floor(Math.random() * 300);
  base = `http://localhost:${port}`;
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: testDb.url,
      NODE_ENV: 'test',
      DEMO_BILLING: '',
      STRIPE_SECRET_KEY: 'sk_test_only',
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      STRIPE_PRICE_INSIDER: 'price_insider_test',
      STRIPE_PRICE_ELITE: 'price_elite_test',
      STRIPE_API_BASE: `http://127.0.0.1:${stripe.port}/v1`,
      ANTHROPIC_API_KEY: 'sk-ant-test-only',
      ANALYSIS_API_BASE: `http://127.0.0.1:${ai.port}`,
      PUBLIC_URL: 'https://example.test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 60; i++) {
    try { await fetch(base + '/api/health'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  ({ user: userA, cookie: cookieA } = await signUp('payer-a@example.com'));
  ({ user: userB, cookie: cookieB } = await signUp('payer-b@example.com'));
});

after(async () => {
  server?.kill();
  stripe?.srv.close();
  ai?.srv.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  await testDb?.drop();
});

test('billing is reported as enabled when Stripe is configured', async () => {
  const { data } = await call('GET', '/api/config');
  assert.equal(data.billingEnabled, true);
  assert.equal(data.demoBilling, false);
});

test('checkout requires a logged-in user and a valid plan', async () => {
  assert.equal((await call('POST', '/api/billing/checkout', { body: { plan: 'insider' } })).status, 401);
  assert.equal((await call('POST', '/api/billing/checkout', { body: { plan: 'free' }, cookie: cookieA })).status, 400);
  assert.equal((await call('POST', '/api/billing/checkout', { body: { plan: 'gold' }, cookie: cookieA })).status, 400);
});

test('checkout sends the right price, customer reference and tier to Stripe', async () => {
  const { status, data } = await call('POST', '/api/billing/checkout', { body: { plan: 'insider' }, cookie: cookieA });
  assert.equal(status, 200);
  assert.equal(data.url, 'https://checkout.stripe.test/session_1');
  const sent = stripeCalls.at(-1);
  assert.equal(sent.url, '/v1/checkout/sessions');
  const form = new URLSearchParams(sent.body);
  assert.equal(form.get('mode'), 'subscription');
  assert.equal(form.get('line_items[0][price]'), 'price_insider_test');
  assert.equal(form.get('client_reference_id'), String(userA.id));
  assert.equal(form.get('metadata[tier]'), 'insider');
  assert.equal(form.get('customer_email'), 'payer-a@example.com');
  assert.equal(form.get('success_url'), 'https://example.test/#/account?checkout=success');
});

test('a valid checkout.session.completed webhook upgrades the account', async () => {
  const event = {
    id: 'evt_test_1',
    type: 'checkout.session.completed',
    data: { object: { client_reference_id: String(userA.id), customer: 'cus_test_A', subscription: 'sub_test_A', metadata: { tier: 'insider' } } },
  };
  assert.equal((await postWebhook(event)).status, 200);
  const me = await call('GET', '/api/auth/me', { cookie: cookieA });
  assert.equal(me.data.user.tier, 'insider');
});

test('webhooks with a bad signature or a stale timestamp are rejected', async () => {
  const payload = JSON.stringify({ id: 'evt_x', type: 'customer.subscription.deleted', data: { object: { id: 'sub_test_A', customer: 'cus_test_A', status: 'canceled' } } });
  const wrong = await call('POST', '/api/billing/webhook', { body: payload, headers: { 'Stripe-Signature': sign(payload, 'whsec_wrong') } });
  assert.equal(wrong.status, 400);
  const stale = await call('POST', '/api/billing/webhook', { body: payload, headers: { 'Stripe-Signature': sign(payload, WEBHOOK_SECRET, 3600) } });
  assert.equal(stale.status, 400);
  const missing = await call('POST', '/api/billing/webhook', { body: payload });
  assert.equal(missing.status, 400);
  const me = await call('GET', '/api/auth/me', { cookie: cookieA });
  assert.equal(me.data.user.tier, 'insider', 'rejected webhooks must not change the plan');
});

test('a paid user cannot start a second checkout, and gets a portal link', async () => {
  assert.equal((await call('POST', '/api/billing/checkout', { body: { plan: 'elite' }, cookie: cookieA })).status, 409);
  const portal = await call('POST', '/api/billing/portal', { cookie: cookieA });
  assert.equal(portal.data.url, 'https://billing.stripe.test/portal_1');
});

test('subscription updates move the account between plans and back to free', async () => {
  const update = (status, price) => postWebhook({
    id: `evt_${status}_${price}`,
    type: 'customer.subscription.updated',
    data: { object: { id: 'sub_test_A', customer: 'cus_test_A', status, items: { data: [{ price: { id: price } }] }, metadata: {} } },
  });
  assert.equal((await update('active', 'price_elite_test')).status, 200);
  assert.equal((await call('GET', '/api/auth/me', { cookie: cookieA })).data.user.tier, 'elite');

  assert.equal((await update('canceled', 'price_elite_test')).status, 200);
  assert.equal((await call('GET', '/api/auth/me', { cookie: cookieA })).data.user.tier, 'free');
});

test('demo upgrades are unavailable when DEMO_BILLING is off', async () => {
  const { status } = await call('POST', '/api/billing/demo-upgrade', { body: { plan: 'elite' }, cookie: cookieB });
  assert.equal(status, 404);
});

test('AI analysis uses the model when a key is set, and Elite gating still applies', async () => {
  // Upgrade B to Elite through a valid webhook so the analysis endpoint is reachable.
  await postWebhook({
    id: 'evt_b_elite',
    type: 'checkout.session.completed',
    data: { object: { client_reference_id: String(userB.id), customer: 'cus_test_B', subscription: 'sub_test_B', metadata: { tier: 'elite' } } },
  });
  const denied = await call('GET', '/api/premium/analysis/unc/football', { cookie: cookieA });
  assert.equal(denied.status, 402);

  const before = aiCalls;
  const { data } = await call('GET', '/api/premium/analysis/unc/football', { cookie: cookieB });
  assert.equal(data.source, 'ai');
  assert.equal(data.text, 'Mock analysis text.');
  assert.equal(aiCalls, before + 1);

  // A second request inside the cache window does not call the model again.
  await call('GET', '/api/premium/analysis/unc/football', { cookie: cookieB });
  assert.equal(aiCalls, before + 1);
});
