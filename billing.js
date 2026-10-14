import crypto from 'node:crypto';
import { one, exec, ensureDb } from './db.js';

/*
 * Stripe billing, called over Stripe's REST API directly (no SDK dependency).
 *
 * Required environment variables for live payments:
 *   STRIPE_SECRET_KEY        sk_live_... or sk_test_...
 *   STRIPE_WEBHOOK_SECRET    whsec_... (from the webhook endpoint in the Stripe dashboard)
 *   STRIPE_PRICE_INSIDER     price_... for the $5/month plan
 *   STRIPE_PRICE_ELITE       price_... for the $20/month plan
 *   PUBLIC_URL               e.g. https://YOUR-DOMAIN (used for redirects)
 *
 * Webhook endpoint to register in Stripe: POST {PUBLIC_URL}/api/billing/webhook
 * Events to send: checkout.session.completed, customer.subscription.created,
 *                 customer.subscription.updated, customer.subscription.deleted
 */

const SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_API = process.env.STRIPE_API_BASE || 'https://api.stripe.com/v1';
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, '');
const PRICE_BY_PLAN = {
  insider: process.env.STRIPE_PRICE_INSIDER || '',
  elite: process.env.STRIPE_PRICE_ELITE || '',
};
const PAID_TIERS = ['insider', 'elite'];
const DEMO_BILLING = process.env.DEMO_BILLING === '1' && process.env.NODE_ENV !== 'production';

export const billing = {
  enabled: Boolean(SECRET_KEY && PRICE_BY_PLAN.insider && PRICE_BY_PLAN.elite),
  demo: DEMO_BILLING,
};

const getUserRow = (id) => one('SELECT * FROM users WHERE id = $1', [id]);

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  err.expose = true;
  return err;
}

// Stripe expects nested form fields: line_items[0][price]=...
function encodeForm(obj, prefix, out = new URLSearchParams()) {
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null || value === '') continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (typeof value === 'object') encodeForm(value, name, out);
    else out.append(name, String(value));
  }
  return out;
}

async function stripeRequest(method, endpoint, fields) {
  const res = await fetch(`${STRIPE_API}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: fields ? encodeForm(fields) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw httpError(502, json.error?.message || 'Payment provider request failed.');
  return json;
}

function tierForPrice(priceId) {
  return Object.keys(PRICE_BY_PLAN).find((plan) => PRICE_BY_PLAN[plan] && PRICE_BY_PLAN[plan] === priceId) || null;
}

// Verifies the Stripe-Signature header against the raw request body (HMAC-SHA256, 5 minute tolerance).
function verifySignature(rawBody, header) {
  const parts = header.split(',').map((part) => part.trim().split('='));
  const timestamp = parts.find(([k]) => k === 't')?.[1];
  const signatures = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!timestamp || signatures.length === 0) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const expected = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(`${timestamp}.${rawBody.toString('utf8')}`)
    .digest('hex');
  const expectedBuf = Buffer.from(expected);
  return signatures.some((sig) => {
    const sigBuf = Buffer.from(sig);
    return sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf);
  });
}

export function registerBillingRoutes(app, { requireUser }) {
  // Starts a Stripe Checkout subscription for the chosen plan.
  app.post('/api/billing/checkout', requireUser, async (req, res) => {
    if (!billing.enabled) throw httpError(503, 'Payments are not configured yet.');
    const plan = req.body?.plan;
    if (!PAID_TIERS.includes(plan)) throw httpError(400, 'Choose a valid plan.');

    const user = await getUserRow(req.user.id);
    if (user.tier !== 'free') {
      throw httpError(409, 'You already have a paid plan. Use Manage billing to change it.');
    }

    const session = await stripeRequest('POST', '/checkout/sessions', {
      mode: 'subscription',
      client_reference_id: String(user.id),
      customer: user.stripe_customer_id || undefined,
      customer_email: user.stripe_customer_id ? undefined : user.email,
      line_items: { 0: { price: PRICE_BY_PLAN[plan], quantity: 1 } },
      metadata: { tier: plan },
      subscription_data: { metadata: { tier: plan } },
      success_url: `${PUBLIC_URL}/#/account?checkout=success`,
      cancel_url: `${PUBLIC_URL}/#/pricing`,
    });
    res.json({ url: session.url });
  });

  // Opens the Stripe customer portal so users can change or cancel their plan.
  app.post('/api/billing/portal', requireUser, async (req, res) => {
    if (!billing.enabled) throw httpError(503, 'Payments are not configured yet.');
    const user = await getUserRow(req.user.id);
    if (!user.stripe_customer_id) throw httpError(400, 'No billing profile found for this account.');
    const portal = await stripeRequest('POST', '/billing_portal/sessions', {
      customer: user.stripe_customer_id,
      return_url: `${PUBLIC_URL}/#/account`,
    });
    res.json({ url: portal.url });
  });

  // Local testing only. Enabled with DEMO_BILLING=1 and never in production.
  app.post('/api/billing/demo-upgrade', requireUser, async (req, res) => {
    if (!DEMO_BILLING) throw httpError(404, 'Not found.');
    const plan = req.body?.plan;
    if (!PAID_TIERS.includes(plan) && plan !== 'free') throw httpError(400, 'Choose a valid plan.');
    await exec('UPDATE users SET tier = $1 WHERE id = $2', [plan, req.user.id]);
    res.json({ ok: true, tier: plan });
  });
}

// Mounted before express.json() because signature checks need the untouched raw body.
export async function stripeWebhook(req, res) {
  if (!WEBHOOK_SECRET) return res.status(503).end();
  // Signature checks need the exact bytes Stripe sent. Only accept a raw Buffer here.
  const raw = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.isBuffer(req.body) ? req.body : null;
  const signature = req.get('stripe-signature');
  if (!raw || !signature || !verifySignature(raw, signature)) {
    return res.status(400).send('Invalid signature');
  }
  await ensureDb();

  const event = JSON.parse(raw.toString('utf8'));
  const obj = event.data.object;

  switch (event.type) {
    case 'checkout.session.completed': {
      const userId = Number(obj.client_reference_id);
      const tier = obj.metadata?.tier;
      if (userId && PAID_TIERS.includes(tier)) {
        await exec('UPDATE users SET tier = $1, stripe_customer_id = $2, stripe_subscription_id = $3 WHERE id = $4', [tier, obj.customer, obj.subscription, userId]);
      }
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const activeStatuses = ['active', 'trialing', 'past_due'];
      const keepsAccess = event.type !== 'customer.subscription.deleted' && activeStatuses.includes(obj.status);
      const priceId = obj.items?.data?.[0]?.price?.id;
      const tier = keepsAccess ? tierForPrice(priceId) || obj.metadata?.tier || 'free' : 'free';
      await exec('UPDATE users SET tier = $1, stripe_subscription_id = $2 WHERE stripe_customer_id = $3', [PAID_TIERS.includes(tier) ? tier : 'free', obj.id, obj.customer]);
      break;
    }
    default:
      break;
  }

  res.json({ received: true });
}
