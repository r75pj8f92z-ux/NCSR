// Pro Sports: logic tests on fixed inputs, and the /api/pro endpoint against a fake ESPN.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTestDatabase } from './helpers.js';
import { PRO_TEAMS, normalizeGame, statusKind, rankArticles, classifyArticle, resetProCaches } from '../pro.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PANTHERS = PRO_TEAMS.panthers;

function competitor({ id, name, abbr, homeAway, score, record = '0-0', rank }) {
  return {
    homeAway, score,
    team: { id: String(id), displayName: name, shortDisplayName: name, abbreviation: abbr, logo: `https://a.espncdn.com/i/teamlogos/nfl/500/${abbr.toLowerCase()}.png` },
    records: [{ summary: record }],
    curatedRank: rank ? { current: rank } : undefined,
  };
}

function event({ id, date, state = 'pre', detail = 'TBD', us, them, headlines = [], links = [] }) {
  return {
    id, date,
    competitions: [{
      status: { type: { state, shortDetail: detail, name: state === 'in' ? 'STATUS_IN_PROGRESS' : state === 'post' ? 'STATUS_FINAL' : 'STATUS_SCHEDULED' } },
      venue: { fullName: 'Bank of America Stadium', address: { city: 'Charlotte', state: 'NC' } },
      competitors: [
        competitor({ id: 29, name: 'Carolina Panthers', abbr: 'CAR', homeAway: 'home', score: us }),
        competitor({ id: 8, name: 'Detroit Lions', abbr: 'DET', homeAway: 'away', score: them }),
      ],
      headlines,
      leaders: [],
    }],
    links,
  };
}

test('statusKind reads ESPN state, including postponed games', () => {
  assert.equal(statusKind({ type: { state: 'pre', name: 'STATUS_SCHEDULED' } }), 'upcoming');
  assert.equal(statusKind({ type: { state: 'in', name: 'STATUS_IN_PROGRESS' } }), 'live');
  assert.equal(statusKind({ type: { state: 'post', name: 'STATUS_FINAL' } }), 'final');
  assert.equal(statusKind({ type: { state: 'pre', name: 'STATUS_POSTPONED' } }), 'postponed');
});

test('normalizeGame reads the score, opponent, venue, recap text and real ESPN links', () => {
  const ev = event({
    id: 'g1', date: '2026-10-04T00:20Z', state: 'post', detail: 'Final', us: 32, them: 26,
    headlines: [{ type: 'Recap', description: 'Bryce Young threw for 300 yards as the Panthers held off the Lions.' }],
    links: [
      { rel: ['gamecast', 'event'], href: 'https://www.espn.com/nfl/game/_/gameId/1' },
      { rel: ['recap', 'event'], href: 'https://www.espn.com/nfl/recap?gameId=1' },
      { rel: ['boxscore', 'event'], href: 'https://www.espn.com/nfl/boxscore/_/gameId/1' },
    ],
  });
  const g = normalizeGame(ev, PANTHERS);
  assert.equal(g.status, 'final');
  assert.deepEqual(g.score, { us: 32, them: 26 });
  assert.equal(g.isHome, true);
  assert.equal(g.opponent.name, 'Detroit Lions');
  assert.equal(g.venue.name, 'Bank of America Stadium');
  assert.match(g.recap.text, /Bryce Young/);
  assert.equal(g.links.recap, 'https://www.espn.com/nfl/recap?gameId=1');
  assert.equal(g.links.preview, null, 'no preview link exists yet for a finished game');
});

test('a game with no recap headline reports recap as null, not a broken object', () => {
  const ev = event({ id: 'g2', date: '2026-10-18T17:00Z', state: 'pre', detail: '10/18 - 1:00 PM EDT' });
  const g = normalizeGame(ev, PANTHERS);
  assert.equal(g.status, 'upcoming');
  assert.equal(g.recap, null);
  assert.equal(g.score.us, null);
});

test('rankArticles keeps only stories tagged with this team, and ranks specific stories first', () => {
  const articles = [
    { id: '1', headline: 'NFL Power Rankings: all 32 teams', published: '2026-10-08T12:00Z', categories: Array.from({ length: 32 }, (_, i) => ({ type: 'team', teamId: i + 1 })) },
    { id: '2', headline: 'Bryce Young, McMillan lead Panthers past Lions', published: '2026-10-05T12:00Z', categories: [{ type: 'team', teamId: 29 }, { type: 'team', teamId: 8 }] },
    { id: '3', headline: 'Jets news that has nothing to do with Carolina', published: '2026-10-09T12:00Z', categories: [{ type: 'team', teamId: 20 }] },
  ];
  const ranked = rankArticles(articles, PANTHERS, 10);
  assert.equal(ranked.length, 2, 'the Jets-only story is dropped');
  assert.equal(ranked[0].id, '2', 'the two-team game story outranks the 32-team round-up');
  assert.equal(ranked[0].specific, true);
  assert.equal(ranked[1].specific, false);
});

test('classifyArticle: an injury story outranks a "vs." scheduling word in the same headline', () => {
  const a = { headline: 'Panthers put Legette on IR; Coker also likely out vs. Lions', description: '' };
  assert.equal(classifyArticle(a, 1), 'Injury Update');
});

test('classifyArticle: a game story with a quote is still recognized as a recap', () => {
  const a = { headline: "Young to McAfee: 'We rally around the city'", description: 'Panthers rally past the Lions 32-26.' };
  assert.equal(classifyArticle(a, 2), 'Game Recap');
});

test('classifyArticle: transactions and draft stories are recognized', () => {
  assert.equal(classifyArticle({ headline: 'Panthers sign veteran safety', description: '' }, 1), 'Transactions');
  assert.equal(classifyArticle({ headline: '2027 mock draft: first round projections', description: '' }, 20), 'Draft');
});

test('every ranked article is marked not-breaking, since no editorial flag exists yet', () => {
  const articles = [{ id: '1', headline: 'Panthers news', published: '2026-10-05T00:00Z', categories: [{ type: 'team', teamId: 29 }] }];
  const [article] = rankArticles(articles, PANTHERS, 10);
  assert.equal(article.breaking, false);
});

test('classifyArticle: a 32-team round-up with no other signal is League News, not Team News', () => {
  const a = { headline: 'NFL Week 5 betting: odds, lines and totals for every game', description: '' };
  assert.equal(classifyArticle(a, 32), 'League News');
});

// ---------- endpoint against a fake ESPN ----------

let espn, server, base, tmp, testDb;

function nflSchedule() {
  return { events: [
    event({ id: 'g1', date: '2026-10-04T00:20Z', state: 'post', detail: 'Final', us: 32, them: 26 }),
    event({ id: 'g2', date: '2026-10-18T17:00Z', state: 'pre', detail: '10/18 - 1:00 PM EDT' }),
  ] };
}

before(async () => {
  testDb = await createTestDatabase();
  espn = http.createServer((req, res) => {
    const json = (body) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url.includes('/football/nfl/teams/29/schedule')) return json(nflSchedule());
    if (req.url.includes('/football/nfl/teams/29')) return json({ team: { record: { items: [{ type: 'total', summary: '2-2' }] }, standingSummary: '1st in NFC South', logos: [{ href: 'https://a.espncdn.com/i/teamlogos/nfl/500/car.png' }] } });
    if (req.url.includes('/football/nfl/scoreboard')) return json({ events: [] });
    if (req.url.includes('/football/nfl/news')) return json({ articles: [
      { id: 'a1', headline: 'Bryce Young, McMillan lead Panthers past Lions', description: 'A recap.', published: '2026-10-04T05:00Z', links: { web: { href: 'https://www.espn.com/a1' } }, categories: [{ type: 'team', teamId: 29 }, { type: 'team', teamId: 8 }] },
    ] });
    // Hornets and Hurricanes: minimal but valid, so buildPro() doesn't throw.
    if (req.url.includes('/teams/')) return json({ team: { record: { items: [{ type: 'total', summary: '0-0' }] }, standingSummary: null, logos: [] } });
    if (req.url.includes('/scoreboard')) return json({ events: [] });
    if (req.url.includes('/news')) return json({ articles: [] });
    if (req.url.includes('/standings')) return json({ season: { year: 2026 }, children: [
      { name: 'National Football Conference', standings: { entries: [
        { team: { id: '29', displayName: 'Carolina Panthers', abbreviation: 'CAR', logos: [] }, stats: [{ name: 'overall', displayValue: '2-2' }, { name: 'winPercent', displayValue: '.500' }, { name: 'gamesBehind', displayValue: '2' }, { name: 'streak', displayValue: 'W1' }] },
      ] } },
    ] });
    json({});
  });
  await new Promise((r) => espn.listen(0, '127.0.0.1', r));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ncsr-pro-'));
  const port = 4800 + Math.floor(Math.random() * 300);
  base = `http://localhost:${port}`;
  const espnBase = `http://127.0.0.1:${espn.address().port}`;
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), DATABASE_URL: testDb.url, NODE_ENV: 'test', DEMO_BILLING: '', ESPN_API_BASE: espnBase, ESPN_WEB_API_BASE: espnBase },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 60; i++) {
    try { await fetch(base + '/api/health'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
});

after(async () => {
  server?.kill();
  espn?.close();
  await testDb?.drop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('/api/pro serves real-shaped team, schedule, news and standings data', async () => {
  const res = await fetch(base + '/api/pro');
  assert.equal(res.status, 200);
  const data = await res.json();
  const panthers = data.teams.panthers;
  assert.equal(panthers.record, '2-2');
  assert.equal(panthers.standingSummary, '1st in NFC South');
  assert.equal(panthers.last.score.us, 32);
  assert.equal(panthers.next.status, 'upcoming');
  assert.equal(panthers.news.length, 1);
  assert.equal(panthers.news[0].category, 'Game Recap');
  assert.equal(panthers.news[0].url, 'https://www.espn.com/a1');
  assert.ok(data.standings.nfl.conferences.some((c) => c.entries.some((e) => e.abbr === 'CAR')));
  // Hornets and Hurricanes still come back with an empty-but-valid shape, not an error.
  assert.deepEqual(data.teams.hornets.news, []);
  assert.equal(data.teams.hornets.next, null);
});

test('a team that ESPN has nothing on today does not break the response', async () => {
  const res = await fetch(base + '/api/pro');
  const data = await res.json();
  assert.equal(data.teams.hurricanes.last, null);
  assert.equal(data.teams.hurricanes.live, null);
});
