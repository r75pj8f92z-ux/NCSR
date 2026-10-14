import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { q, one, exec, ensureDb } from './db.js';
import { dataFile } from './paths.js';
import { sendPasswordReset, mailConfigured } from './mail.js';
import { billing, registerBillingRoutes, stripeWebhook } from './billing.js';
import { getRadar } from './radar.js';
import { buildNc7 } from './nc7.js';
import { buildPro } from './pro.js';

const content = JSON.parse(fs.readFileSync(dataFile('content.json'), 'utf8'));
const rosters = JSON.parse(fs.readFileSync(dataFile('rosters.json'), 'utf8'));

const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const ANALYSIS_TTL_MS = 6 * 60 * 60 * 1000;
const analysisCache = new Map();
const RANK = { free: 0, insider: 1, elite: 2 };
const SPORTS = ['football', 'mens-basketball'];
const programById = new Map(content.programs.map((p) => [p.id, p]));

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);

// Baseline security headers. Scripts and styles load from this origin plus Google Fonts.
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self' https://cdnjs.cloudflare.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: https://tile.openstreetmap.org https://*.tile.openstreetmap.org https://a.espncdn.com https://s.espncdn.com https://*.espncdn.com https://espnmedia-cdn.akamaized.net",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  });
  next();
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

// Stripe webhooks need the raw body for signature checks, so this route comes before express.json().
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), stripeWebhook);
app.use(express.json({ limit: '50kb' }));

// ---------- helpers ----------

const clean = (value, min, max) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length >= min && trimmed.length <= max ? trimmed : null;
};

const httpError = (status, message) => Object.assign(new Error(message), { status, expose: true });

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(password, salt, 64);
  const reference = Buffer.from(hash, 'hex');
  return reference.length === candidate.length && crypto.timingSafeEqual(reference, candidate);
}

const publicUser = (row) => ({
  id: row.id,
  email: row.email,
  displayName: row.display_name,
  tier: row.tier,
});

// ---------- sessions, auth and password reset (Postgres) ----------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN_RE = /^[a-f0-9]{64}$/;
const RESET_MS = 60 * 60 * 1000;
const AUTH_WINDOW_MS = 15 * 60 * 1000;
const AUTH_MAX = Number(process.env.AUTH_RATE_MAX) || 20;

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const isUniqueViolation = (err) => err?.code === '23505';
// Hashed once at startup so unknown emails cost the same time as real ones at login.
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

async function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await exec('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [sha256(token), userId, Date.now() + SESSION_MS]);
  res.cookie('nc_session', token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MS,
    secure: process.env.NODE_ENV === 'production',
  });
}

// Attaches req.user (or null) to every request from the session cookie. The cookie holds a random token;
// the database holds only its hash.
app.use(async (req, res, next) => {
  try {
    await ensureDb();
    req.user = null;
    const token = parseCookies(req).nc_session;
    if (token && TOKEN_RE.test(token)) {
      const row = await one(
        'SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > $2',
        [sha256(token), Date.now()],
      );
      if (row) {
        req.user = publicUser(row);
        req.sessionToken = token;
      }
    }
    next();
  } catch (err) {
    next(err);
  }
});

// Blocks cross-site form posts: a state-changing request from another origin is refused.
function sameOrigin(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (!origin) return next();
  const allowed = [req.protocol + '://' + req.get('host')];
  if (process.env.PUBLIC_URL) allowed.push(process.env.PUBLIC_URL.replace(/\/$/, ''));
  if (!allowed.includes(origin)) return next(httpError(403, 'Request blocked.'));
  next();
}
app.use('/api', sameOrigin);

function requireUser(req, res, next) {
  if (!req.user) return next(httpError(401, 'Please log in to continue.'));
  next();
}

function requireTier(tier) {
  return (req, res, next) => {
    if (!req.user) return next(httpError(401, 'Please log in to continue.'));
    if (RANK[req.user.tier] < RANK[tier]) {
      return next(httpError(402, `This content requires the ${tier[0].toUpperCase()}${tier.slice(1)} plan.`));
    }
    next();
  };
}

// Limits sign-in, sign-up and reset requests per IP. The count lives in Postgres so it holds across instances.
async function authLimiter(req, res, next) {
  try {
    const now = Date.now();
    const since = now - AUTH_WINDOW_MS;
    await exec('DELETE FROM auth_attempts WHERE at < $1', [since]);
    const row = await one('SELECT COUNT(*)::int AS n FROM auth_attempts WHERE ip = $1 AND at >= $2', [req.ip || 'unknown', since]);
    if (row.n >= AUTH_MAX) return next(httpError(429, 'Too many attempts. Try again in a few minutes.'));
    await exec('INSERT INTO auth_attempts (ip, at) VALUES ($1, $2)', [req.ip || 'unknown', now]);
    next();
  } catch (err) {
    next(err);
  }
}

const passwordOk = (password) => typeof password === 'string' && password.length >= 8 && password.length <= 200;

app.post('/api/auth/signup', authLimiter, async (req, res) => {
  const email = clean(req.body?.email, 5, 254)?.toLowerCase();
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!email || !EMAIL_RE.test(email)) throw httpError(400, 'Enter a valid email address.');
  if (!passwordOk(password)) throw httpError(400, 'Password must be at least 8 characters.');
  const displayName = clean(req.body?.displayName, 1, 30) || email.split('@')[0].slice(0, 30);
  try {
    const row = await one(
      'INSERT INTO users (email, password_hash, display_name, tier, created_at) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [email, hashPassword(password), displayName, 'free', Date.now()],
    );
    await startSession(res, row.id);
    res.status(201).json({ user: publicUser(row) });
  } catch (err) {
    // Same wording whether or not the email already has an account, so sign-up can't be used to find accounts.
    if (isUniqueViolation(err)) throw httpError(409, 'We could not create that account. If you already have one, log in or reset your password.');
    throw err;
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const email = clean(req.body?.email, 1, 254)?.toLowerCase() || '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const row = email ? await one('SELECT * FROM users WHERE email = $1', [email]) : null;
  const ok = verifyPassword(password, row ? row.password_hash : DUMMY_HASH);
  if (!row || !ok) throw httpError(401, 'Invalid email or password.');
  await startSession(res, row.id);
  res.json({ user: publicUser(row) });
});

app.post('/api/auth/logout', async (req, res) => {
  if (req.sessionToken) await exec('DELETE FROM sessions WHERE token_hash = $1', [sha256(req.sessionToken)]);
  res.clearCookie('nc_session', { path: '/' });
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  res.json({ user: req.user });
});

// Always gives the same answer, so the form can't be used to find accounts.
app.post('/api/auth/forgot', authLimiter, async (req, res) => {
  const email = clean(req.body?.email, 5, 254)?.toLowerCase();
  const reply = { ok: true, message: 'If an account exists for that email, a reset link is on its way.' };
  if (!email || !EMAIL_RE.test(email)) return res.json(reply);
  const row = await one('SELECT id, email FROM users WHERE email = $1', [email]);
  if (row) {
    const token = crypto.randomBytes(32).toString('hex');
    await exec('INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [sha256(token), row.id, Date.now() + RESET_MS]);
    const origin = (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    try {
      await sendPasswordReset(row.email, `${origin}/#/reset?token=${token}`);
    } catch (err) {
      console.error('Password reset email failed:', err.message);
    }
  }
  res.json(reply);
});

// Single use, one hour. Signs the account out everywhere.
app.post('/api/auth/reset', authLimiter, async (req, res) => {
  const token = typeof req.body?.token === 'string' ? req.body.token : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!TOKEN_RE.test(token)) throw httpError(400, 'This reset link is invalid or has expired.');
  if (!passwordOk(password)) throw httpError(400, 'Password must be at least 8 characters.');
  const hash = sha256(token);
  const row = await one('SELECT * FROM password_resets WHERE token_hash = $1 AND used = FALSE AND expires_at > $2', [hash, Date.now()]);
  if (!row) throw httpError(400, 'This reset link is invalid or has expired.');
  await exec('UPDATE users SET password_hash = $1 WHERE id = $2', [hashPassword(password), row.user_id]);
  await exec('UPDATE password_resets SET used = TRUE WHERE token_hash = $1', [hash]);
  await exec('DELETE FROM sessions WHERE user_id = $1', [row.user_id]);
  res.json({ ok: true });
});

// ---------- public config ----------

const programSummary = (p) => ({
  id: p.id,
  name: p.name,
  nickname: p.nickname,
  short: p.short,
  color: p.color,
});

app.get('/api/config', (req, res) => {
  res.json({
    brand: content.brand,
    programs: content.programs.map(programSummary),
    sports: content.sports,
    plans: content.plans,
    social: content.social,
    billingEnabled: billing.enabled,
    demoBilling: billing.demo,
  });
});

// ---------- NC Sports Radar (public homepage module) ----------

app.get('/api/radar', async (req, res) => {
  res.set('Cache-Control', 'public, max-age=30');
  res.json(await getRadar(content.programs));
});

// ---------- NCSR Live Map (public) ----------

app.get('/api/nc7', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await buildNc7(content.programs));
});

// ---------- Pro Sports: Panthers, Hornets, Hurricanes (public) ----------

app.get('/api/pro', async (req, res) => {
  res.set('Cache-Control', 'public, max-age=20');
  res.json(await buildPro());
});

// ---------- news (tier-gated on the server, not just in the UI) ----------

app.get('/api/news', (req, res) => {
  const level = RANK[req.user?.tier ?? 'free'];
  const { program, sport } = req.query;
  const items = content.news
    .filter((n) => (!program || n.program === program) && (!sport || n.sport === sport))
    .sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''))
    .map((n) => {
      const base = {
        id: n.id,
        title: n.title,
        summary: n.summary,
        program: n.program,
        sport: n.sport,
        tier: n.tier,
        publishedAt: n.publishedAt,
        sourceName: n.sourceName || null,
        sourceUrl: n.sourceUrl || null,
      };
      return RANK[n.tier] <= level ? { ...base, body: n.body, locked: false } : { ...base, locked: true };
    });
  res.json(items);
});

// ---------- programs ----------

app.get('/api/programs/:id', (req, res) => {
  const program = programById.get(req.params.id);
  if (!program) throw httpError(404, 'Program not found.');
  const level = RANK[req.user?.tier ?? 'free'];
  res.json({
    ...programSummary(program),
    overview: program.overview,
    sports: program.sports,
    insider: level >= RANK.insider ? program.insider : null,
    history: level >= RANK.elite ? program.history : null,
    locked: { insider: level < RANK.insider, elite: level < RANK.elite },
  });
});

// ---------- premium: NC Metrics, rosters with player stats, analysis (Elite) ----------

const metrics = JSON.parse(fs.readFileSync(dataFile('metrics.json'), 'utf8'));
const sportName = (id) => (id === 'football' ? 'football' : "men's basketball");

function gamesOnRecord(programId, sport) {
  const record = programById.get(programId)?.sports?.[sport]?.record;
  const m = record && record.match(/(\d+)\D+(\d+)/);
  return m ? Number(m[1]) + Number(m[2]) : null;
}

// Season stat line shown in the roster table, e.g. "611 pass yds, 3 TD · 112 tkl".
function playerSummary(sport, stats) {
  const get = (group) => {
    const g = stats?.[group];
    return g ? Object.fromEntries(g.fields.map((f) => [f.label, f.value])) : null;
  };
  const parts = [];
  if (sport === 'football') {
    const pass = get('Passing');
    const rush = get('Rushing');
    const rec = get('Receiving');
    const def = get('Defense');
    const kick = get('Kicking');
    const punt = get('Punting');
    if (pass && Number(pass.ATT) > 0) parts.push(`${pass.YDS} pass yds, ${pass.TD} TD, ${pass.INT} INT`);
    if (rush && Number(rush.CAR) > 0) parts.push(`${rush.CAR} car, ${rush.YDS} rush yds`);
    if (rec && Number(rec.REC) > 0) parts.push(`${rec.REC} rec, ${rec.YDS} rec yds`);
    if (def && Number(def.TOT) > 0) parts.push(`${def.TOT} tkl, ${def.SACK} sk, ${def.INT} INT`);
    if (kick && Number(kick.FGA) > 0) parts.push(`${kick.FGM}/${kick.FGA} FG`);
    if (punt && Number(punt.PUNTS) > 0 && parts.length === 0) parts.push(`${punt.PUNTS} punts, ${punt.AVG} avg`);
  } else {
    const avg = get('Season Averages');
    if (avg && Number(avg.GP) > 0) parts.push(`${avg.PTS} pts · ${avg.REB} reb · ${avg.AST} ast (${avg.GP} GP)`);
  }
  return parts.join(' · ') || null;
}

function playerDetails(stats) {
  return Object.entries(stats || {}).map(([title, g]) => ({
    title,
    team: g.team,
    fields: g.fields.map((f) => ({ label: f.label, value: f.value })),
  }));
}

app.get('/api/premium/metrics', requireTier('elite'), (req, res) => {
  const teams = [];
  for (const [programId, bySport] of Object.entries(metrics.teams)) {
    for (const [sport, data] of Object.entries(bySport)) {
      const onRecord = gamesOnRecord(programId, sport);
      teams.push({
        programId,
        sport,
        season: data.season,
        gamesCounted: data.gamesCounted,
        gamesOnRecord: onRecord,
        stale: sport === 'football' && onRecord !== null && data.gamesCounted < onRecord,
        stats: data.stats,
      });
    }
  }
  res.json({ updatedAt: metrics.updatedAt, source: metrics.source, definitions: metrics.definitions, teams });
});

app.get('/api/premium/roster/:id/:sport', requireTier('elite'), (req, res) => {
  const { id, sport } = req.params;
  if (!programById.has(id) || !SPORTS.includes(sport)) throw httpError(404, 'Not found.');
  const program = programById.get(id);
  const players = (rosters.teams?.[id]?.[sport]?.players ?? []).map((p) => {
    const groups = playerDetails(p.stats);
    const current = groups.find((g) => g.team && g.team.includes(program.nickname));
    return {
      number: p.number,
      name: p.name,
      pos: p.pos,
      year: p.year,
      height: p.height,
      weight: p.weight,
      hometown: p.hometown,
      summary: playerSummary(sport, p.stats),
      statsTeam: groups[0]?.team && !groups[0].team.includes(program.nickname) ? groups[0].team : null,
      hasCurrentStats: Boolean(current),
      details: groups,
    };
  });
  res.json({ players, updatedAt: rosters.updatedAt ?? null, source: rosters.source ?? null });
});

// Plain-language analysis built from the team's metrics and roster. Used when no AI key is set.
function statsAnalysis(program, sport, team, roster) {
  const defs = Object.fromEntries((metrics.definitions[sport] || []).map((d) => [d.key, d]));
  const st = team.stats;
  const lines = [];
  const fmt = (key, v) => (defs[key]?.unit === 'pct' ? `${v}%` : `${v}`);
  if (st.ptsPerGame && st.ptsAllowedPerGame && sport === 'football') {
    lines.push(`${program.name} scores ${fmt('ptsPerGame', st.ptsPerGame.value)} points per game (${st.ptsPerGame.rank} of 7) and allows ${fmt('ptsAllowedPerGame', st.ptsAllowedPerGame.value)} (${st.ptsAllowedPerGame.rank} of 7).`);
  } else if (st.ptsPerGame) {
    lines.push(`${program.name} averaged ${fmt('ptsPerGame', st.ptsPerGame.value)} points per game in the last completed season (${st.ptsPerGame.rank} of 7).`);
  }
  const strengths = Object.entries(st).filter(([k, v]) => v.rank && v.rank <= 2 && defs[k]).map(([k, v]) => `${defs[k].label} (${fmt(k, v.value)}, ${v.rank} of 7)`);
  const concerns = Object.entries(st).filter(([k, v]) => v.rank && v.rank >= 6 && defs[k]).map(([k, v]) => `${defs[k].label} (${fmt(k, v.value)}, ${v.rank} of 7)`);
  if (strengths.length) lines.push(`Top two in the seven-program group: ${strengths.join('; ')}.`);
  if (concerns.length) lines.push(`Bottom two in the group: ${concerns.join('; ')}.`);
  const byPos = {};
  for (const p of roster) byPos[p.pos] = (byPos[p.pos] || 0) + 1;
  const posLine = Object.entries(byPos).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([pos, n]) => `${pos} ${n}`).join(', ');
  lines.push(`Roster: ${roster.length} players on file (${posLine}).`);
  return lines.join(' ');
}

async function aiAnalysis(program, sport, team, roster) {
  const prompt = [
    `Write a 180 to 230 word analysis of the ${program.name} ${program.nickname} ${sportName(sport)} team for North Carolina sports fans.`,
    'Use only the data below. If a stat or season is missing, say so. Cover offense, defense, turnovers, roster depth and experience, and what to watch next. Do not invent players, scores or records.',
    JSON.stringify({ season: team.season, gamesCounted: team.gamesCounted, stats: team.stats, roster: roster.map((p) => ({ pos: p.pos, year: p.year, summary: p.summary })) }),
  ].join('\n\n');
  const res = await fetch(`${process.env.ANALYSIS_API_BASE || 'https://api.anthropic.com'}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: process.env.ANALYSIS_MODEL || 'claude-sonnet-5-5',
      max_tokens: 700,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Analysis provider returned ${res.status}`);
  const json = await res.json();
  return json.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
}

app.get('/api/premium/analysis/:id/:sport', requireTier('elite'), async (req, res) => {
  const { id, sport } = req.params;
  const program = programById.get(id);
  if (!program || !SPORTS.includes(sport)) throw httpError(404, 'Not found.');
  const team = metrics.teams[id]?.[sport];
  const roster = (rosters.teams?.[id]?.[sport]?.players ?? []).map((p) => ({ pos: p.pos, year: p.year, summary: playerSummary(sport, p.stats) }));
  if (!team) return res.json({ available: false, source: null, text: 'Team metrics have not been loaded yet.' });

  const key = `${id}:${sport}:${metrics.updatedAt}:${roster.length}:${process.env.ANTHROPIC_API_KEY ? 'ai' : 'stats'}`;
  const cached = analysisCache.get(key);
  if (cached && Date.now() - cached.at < ANALYSIS_TTL_MS) return res.json(cached.result);

  let result;
  try {
    if (process.env.ANTHROPIC_API_KEY) {
      result = { available: true, source: 'ai', text: await aiAnalysis(program, sport, team, roster) };
    } else {
      result = { available: true, source: 'stats', text: statsAnalysis(program, sport, team, roster) };
    }
  } catch {
    result = { available: true, source: 'stats', text: statsAnalysis(program, sport, team, roster) };
  }
  analysisCache.set(key, { at: Date.now(), result });
  res.json(result);
});

// ---------- discussion board (Postgres; clients poll for updates) ----------

const view = (row) => (row ? { ...row, createdAt: Number(row.createdAt) } : null);
const TOPIC_COLUMNS = `t.id, t.title, t.program_id AS "programId", t.created_at AS "createdAt", u.display_name AS author,
  (SELECT COUNT(*)::int FROM replies r WHERE r.topic_id = t.id) AS "replyCount"`;
const topicById = async (id) => view(await one(`SELECT ${TOPIC_COLUMNS}, t.body FROM topics t JOIN users u ON u.id = t.user_id WHERE t.id = $1`, [id]));
const replyById = async (id) => view(await one(
  'SELECT r.id, r.topic_id AS "topicId", r.body, r.created_at AS "createdAt", u.display_name AS author FROM replies r JOIN users u ON u.id = r.user_id WHERE r.id = $1',
  [id],
));

const validProgram = (id) => (id === null || id === undefined || id === '' ? null : programById.has(id) ? id : undefined);

app.get('/api/topics', async (req, res) => {
  const rows = await q(`SELECT ${TOPIC_COLUMNS} FROM topics t JOIN users u ON u.id = t.user_id ORDER BY t.created_at DESC LIMIT 100`);
  res.json(rows.map(view));
});

app.get('/api/topics/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) throw httpError(404, 'Topic not found.');
  const topic = await topicById(id);
  if (!topic) throw httpError(404, 'Topic not found.');
  const replies = await q(
    'SELECT r.id, r.body, r.created_at AS "createdAt", u.display_name AS author FROM replies r JOIN users u ON u.id = r.user_id WHERE r.topic_id = $1 ORDER BY r.created_at ASC LIMIT 500',
    [id],
  );
  res.json({ ...topic, replies: replies.map(view) });
});

// New topics and replies since a time (ms). Clients poll this instead of holding a live connection.
app.get('/api/discussion/updates', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const now = Date.now();
  const since = Math.min(Math.max(Number(req.query.since) || 0, now - 10 * 60 * 1000), now);
  const topics = await q(`SELECT ${TOPIC_COLUMNS} FROM topics t JOIN users u ON u.id = t.user_id WHERE t.created_at > $1 ORDER BY t.created_at ASC LIMIT 50`, [since]);
  const replies = await q(
    'SELECT r.id, r.topic_id AS "topicId", r.body, r.created_at AS "createdAt", u.display_name AS author FROM replies r JOIN users u ON u.id = r.user_id WHERE r.created_at > $1 ORDER BY r.created_at ASC LIMIT 100',
    [since],
  );
  res.json({ now, topics: topics.map(view), replies: replies.map(view) });
});

app.post('/api/topics', requireTier('insider'), async (req, res) => {
  const title = clean(req.body?.title, 5, 140);
  const body = clean(req.body?.body, 1, 5000);
  const programId = validProgram(req.body?.programId);
  if (!title) throw httpError(400, 'Titles need 5 to 140 characters.');
  if (!body) throw httpError(400, 'Add some text to your topic.');
  if (programId === undefined) throw httpError(400, 'Unknown program.');
  const row = await one(
    'INSERT INTO topics (user_id, program_id, title, body, created_at) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [req.user.id, programId, title, body, Date.now()],
  );
  res.status(201).json(await topicById(row.id));
});

app.post('/api/topics/:id/replies', requireUser, async (req, res) => {
  const topicId = Number(req.params.id);
  const body = clean(req.body?.body, 1, 3000);
  if (!body) throw httpError(400, 'Replies need between 1 and 3000 characters.');
  if (!Number.isSafeInteger(topicId) || !(await one('SELECT 1 AS ok FROM topics WHERE id = $1', [topicId]))) {
    throw httpError(404, 'Topic not found.');
  }
  const row = await one(
    'INSERT INTO replies (topic_id, user_id, body, created_at) VALUES ($1, $2, $3, $4) RETURNING id',
    [topicId, req.user.id, body, Date.now()],
  );
  res.status(201).json(await replyById(row.id));
});

// ---------- billing ----------

registerBillingRoutes(app, { requireUser });

// ---------- errors ----------

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON.' });
  }
  if (err.expose) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

export default app;
