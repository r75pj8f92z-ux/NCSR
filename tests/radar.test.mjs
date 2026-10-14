// NC Sports Radar: logic tests on fixed fixtures, plus the endpoint against a fake ESPN.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTestDatabase } from './helpers.js';
import { buildRadar, easternDate } from '../radar.js';

let testDb;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const content = JSON.parse(fs.readFileSync(path.join(root, 'data', 'content.json'), 'utf8'));
const programsByEspnId = new Map(content.programs.map((p) => [String(p.espnId), p]));

// Shaped like ESPN's scoreboard: team details sit under `team`, game data beside it.
function team(id, name, abbr, { score = null, winner = false, rank = 99, record = '1-0' } = {}) {
  return {
    homeAway: 'home', score, winner,
    team: { id, displayName: `${name} Team`, shortDisplayName: name, abbreviation: abbr, logo: '' },
    records: [{ summary: record }], curatedRank: { current: rank },
  };
}

function event({ id, date, state, statusText, competitors, leaders = [] }) {
  return {
    id, date, name: `${competitors[0].team.shortDisplayName} vs ${competitors[1].team.shortDisplayName}`,
    shortName: `${competitors[0].team.abbreviation} vs ${competitors[1].team.abbreviation}`,
    status: { type: { state, shortDetail: statusText } },
    competitions: [{ competitors, leaders }],
  };
}

// Fixture day: a live UNC–Duke game, Wake beating a ranked Louisville, NC State beating unranked Virginia,
// and a national game that should not appear in NC lists.
const events = [
  event({ id: 'live1', date: '2026-10-03T19:00Z', state: 'in', statusText: 'Q3 8:12',
    competitors: [team('153', 'North Carolina', 'UNC', { score: '14' }), team('150', 'Duke', 'DUKE', { score: '10' })] }),
  event({ id: 'wake1', date: '2026-10-03T23:00Z', state: 'post', statusText: 'Final',
    competitors: [team('154', 'Wake Forest', 'WAKE', { score: '28', winner: true }), team('97', 'Louisville', 'LOU', { score: '21', rank: 22, record: '2-3' })],
    leaders: [{ name: 'passingYards', leaders: [{ displayValue: '310 YDS, 3 TD', value: 310, athlete: { displayName: 'Test QB', team: { id: '154' } } }] }] }),
  event({ id: 'ncsu1', date: '2026-10-03T18:00Z', state: 'post', statusText: 'Final',
    competitors: [team('152', 'NC State', 'NCSU', { score: '31', winner: true, record: '3-2' }), team('258', 'Virginia', 'UVA', { score: '8' })],
    leaders: [{ name: 'rushingYards', leaders: [{ displayValue: '120 CAR, 98 YDS', value: 98, athlete: { displayName: 'Test RB', team: { id: '152' } } }] }] }),
  event({ id: 'national1', date: '2026-10-03T20:00Z', state: 'post', statusText: 'Final',
    competitors: [team('87', 'Notre Dame', 'ND', { score: '37', winner: true, rank: 3 }), team('130', 'Michigan', 'MICH', { score: '20', rank: 5 })] }),
];

const scoreboards = { football: { events }, 'mens-basketball': { events: [] } };
const news = [
  { headline: 'Older story', url: 'https://example.test/a', published: '2026-10-02T10:00Z', programId: 'unc', source: 'ESPN' },
  { headline: 'Newest story', url: 'https://example.test/b', published: '2026-10-03T12:00Z', programId: 'wake', source: 'ESPN' },
];

test('lists only North Carolina games as tonight, live or upcoming', () => {
  const radar = buildRadar({ scoreboards, news, programsByEspnId, date: '20261003' });
  assert.equal(radar.tonight.length, 1);
  assert.equal(radar.tonight[0].id, 'live1');
  assert.equal(radar.tonight[0].state, 'in');
});

test('an unranked team beating a ranked one is flagged as an upset', () => {
  const radar = buildRadar({ scoreboards, news, programsByEspnId, date: '20261003' });
  assert.equal(radar.upsets.length, 1);
  assert.equal(radar.upsets[0].winner, 'Wake Forest');
  assert.equal(radar.upsets[0].loser, 'Louisville');
  assert.equal(radar.upsets[0].loserRank, 22);
  assert.equal(radar.upsets[0].score, '28–21');
});

test('a national game with ranked teams is not flagged as an NC upset', () => {
  const radar = buildRadar({ scoreboards, news, programsByEspnId, date: '20261003' });
  assert.ok(!radar.upsets.some((u) => u.winner === 'Notre Dame'));
});

test('latest score is the most recent final involving an NC program', () => {
  const radar = buildRadar({ scoreboards, news, programsByEspnId, date: '20261003' });
  assert.equal(radar.latestScore.id, 'wake1');
});

test('biggest matchup prefers the combined-ranking game among NC teams', () => {
  const radar = buildRadar({ scoreboards, news, programsByEspnId, date: '20261003' });
  assert.equal(radar.biggestMatchup.id, 'wake1');
});

test('trending athlete is the top yardage performance across NC games', () => {
  const radar = buildRadar({ scoreboards, news, programsByEspnId, date: '20261003' });
  assert.equal(radar.trendingAthlete.athlete, 'Test QB');
  assert.equal(radar.trendingAthlete.teamName, 'Wake Forest');
  assert.equal(radar.trendingAthlete.category, 'Passing');
});

test('commitments stay empty until a licensed recruiting feed is connected', () => {
  const radar = buildRadar({ scoreboards, news, programsByEspnId, date: '20261003' });
  assert.equal(radar.latestCommitment, null);
});

test('breaking news is newest first', () => {
  const radar = buildRadar({ scoreboards, news, programsByEspnId, date: '20261003' });
  assert.equal(radar.breakingNews[0].headline, 'Newest story');
});

test('an empty day gives empty sections, not errors', () => {
  const radar = buildRadar({ scoreboards: { football: { events: [] }, 'mens-basketball': { events: [] } }, news: [], programsByEspnId, date: '20261003' });
  assert.deepEqual(radar.tonight, []);
  assert.equal(radar.biggestMatchup, null);
  assert.equal(radar.latestScore, null);
  assert.equal(radar.trendingAthlete, null);
  assert.deepEqual(radar.upsets, []);
});

test('Eastern date formatting for ESPN day keys', () => {
  assert.equal(easternDate(new Date('2026-10-04T02:00:00Z')), '20261003');
  assert.equal(easternDate(new Date('2026-10-04T12:00:00Z')), '20261004');
});

// ---------- endpoint against a fake ESPN ----------

let espn, server, base;
const tmp = null;

before(async () => {
  testDb = await createTestDatabase();
  espn = http.createServer((req, res) => {
    const json = (body) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url.includes('/football/college-football/scoreboard')) return json({ events });
    if (req.url.includes('/basketball/mens-college-basketball/scoreboard')) return json({ events: [] });
    if (req.url.includes('/news')) return json({ articles: [{ headline: 'Shared story', published: '2026-10-03T12:00Z', links: { web: { href: 'https://example.test/shared' } } }] });
    json({});
  });
  await new Promise((r) => espn.listen(0, '127.0.0.1', r));
  const port = 4300 + Math.floor(Math.random() * 300);
  base = `http://localhost:${port}`;
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), DATABASE_URL: testDb.url, NODE_ENV: 'test', DEMO_BILLING: '', ESPN_API_BASE: `http://127.0.0.1:${espn.address().port}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 60; i++) {
    try { await fetch(base + '/api/health'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
});

after(async () => {
  server?.kill();
  espn?.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  await testDb?.drop();
});

test('/api/radar serves the live radar and removes duplicate stories', async () => {
  const res = await fetch(base + '/api/radar');
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.tonight[0].id, 'live1');
  assert.equal(data.upsets.length, 1);
  assert.equal(data.latestCommitment, null);
  const urls = data.breakingNews.map((n) => n.url);
  assert.equal(new Set(urls).size, urls.length, 'no duplicate story links');
  assert.match(res.headers.get('cache-control'), /max-age/);
});
