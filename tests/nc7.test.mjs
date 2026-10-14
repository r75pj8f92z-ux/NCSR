// NCSR Live Map: logic on fixed inputs, and the /api/nc7 endpoint against a fake ESPN.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTestDatabase } from './helpers.js';
import {
  etDate, weekendWindow, haversineMiles, scoreLabel, detectEvents, teamToday, teamState, summarize, normalizeGame,
} from '../nc7.js';

let testDb;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const content = JSON.parse(fs.readFileSync(path.join(root, 'data', 'content.json'), 'utf8'));
const espnToProgram = new Map(content.programs.map((p) => [String(p.espnId), p]));

function ev({ id, date, state = 'pre', detail = 'TBD', period = null, clock = null, us, them, usTeam, theirTeam, usHome = true, venue }) {
  return {
    id, date,
    competitions: [{
      status: { type: { state, shortDetail: detail, name: state === 'in' ? 'STATUS_IN_PROGRESS' : state === 'post' ? 'STATUS_FINAL' : 'STATUS_SCHEDULED' }, period, displayClock: clock },
      venue,
      competitors: [
        { homeAway: usHome ? 'home' : 'away', score: us === undefined ? undefined : String(us), team: usTeam, records: [{ summary: '2-2' }], curatedRank: { current: 99 } },
        { homeAway: usHome ? 'away' : 'home', score: them === undefined ? undefined : String(them), team: theirTeam, records: [{ summary: '3-1' }], curatedRank: { current: 99 } },
      ],
    }],
  };
}

const UNC = { id: '153', displayName: 'North Carolina Tar Heels', shortDisplayName: 'North Carolina', abbreviation: 'UNC' };
const DUKE = { id: '150', displayName: 'Duke Blue Devils', shortDisplayName: 'Duke', abbreviation: 'DUKE' };
const KENAN = { fullName: 'Kenan Stadium', address: { city: 'Chapel Hill', state: 'NC' } };
const WALLACE = { fullName: 'Wallace Wade Stadium', address: { city: 'Durham', state: 'NC' } };

test('weekend window runs Friday to Sunday, including today on a weekend', () => {
  assert.deepEqual(weekendWindow(new Date('2026-10-03T18:00:00Z')), { start: '2026-10-02', end: '2026-10-04' });
  assert.deepEqual(weekendWindow(new Date('2026-10-05T18:00:00Z')), { start: '2026-10-09', end: '2026-10-11' });
  assert.deepEqual(weekendWindow(new Date('2026-10-09T18:00:00Z')), { start: '2026-10-09', end: '2026-10-11' });
});

test('Eastern date is used for "today", not UTC', () => {
  assert.equal(etDate(new Date('2026-10-04T02:00:00Z')), '2026-10-03');
});

test('straight-line distance between Chapel Hill and Charlotte is about 110 miles', () => {
  const miles = haversineMiles({ lat: 35.9132, lng: -79.0558 }, { lat: 35.2271, lng: -80.8431 });
  assert.ok(miles > 105 && miles < 115, `got ${miles}`);
});

test('score labels: field goals and touchdowns in football, plain score otherwise', () => {
  assert.equal(scoreLabel(3, 'football'), 'Field goal');
  assert.equal(scoreLabel(7, 'football'), 'Touchdown');
  assert.equal(scoreLabel(6, 'football'), 'Touchdown');
  assert.equal(scoreLabel(2, 'football'), 'Score');
  assert.equal(scoreLabel(3, 'mens-basketball'), 'Score');
});

test('a normalized game reads the score, venue, opponent and home/away side', () => {
  const g = normalizeGame(ev({ id: 'g1', date: '2026-10-03T16:00Z', state: 'post', detail: 'Final', us: 26, them: 37, usTeam: UNC, theirTeam: { id: '87', displayName: 'Notre Dame Fighting Irish', shortDisplayName: 'Notre Dame', abbreviation: 'ND' }, venue: KENAN }), 'football', 'unc', espnToProgram);
  assert.equal(g.status, 'final');
  assert.deepEqual(g.score, { us: 26, them: 37 });
  assert.equal(g.isHome, true);
  assert.equal(g.venue.name, 'Kenan Stadium');
  assert.equal(g.opponent.name, 'Notre Dame');
});

test('events fire on score changes, halftime and final, but not on the first snapshot', () => {
  const previous = new Map();
  const before = normalizeGame(ev({ id: 'g2', date: '2026-10-03T16:00Z', state: 'in', detail: '2nd 4:10', us: 10, them: 7, usTeam: UNC, theirTeam: DUKE, venue: KENAN }), 'football', 'unc', espnToProgram);
  assert.deepEqual(detectEvents([before], previous), [], 'first snapshot is silent');

  const after = normalizeGame(ev({ id: 'g2', date: '2026-10-03T16:00Z', state: 'in', detail: 'Halftime', us: 17, them: 7, usTeam: UNC, theirTeam: DUKE, venue: KENAN }), 'football', 'unc', espnToProgram);
  const events = detectEvents([after], previous);
  assert.deepEqual(events.map((e) => e.type), ['Touchdown', 'Halftime']);
  assert.equal(events[0].scorer, 'us');

  const done = normalizeGame(ev({ id: 'g2', date: '2026-10-03T16:00Z', state: 'post', detail: 'Final', us: 17, them: 10, usTeam: UNC, theirTeam: DUKE, venue: KENAN }), 'football', 'unc', espnToProgram);
  // Duke kicked a field goal on the last snapshot, so Duke gets the scoring event; the game then goes final.
  const doneEvents = detectEvents([done], previous);
  assert.deepEqual(doneEvents.map((e) => e.type), ['Field goal', 'Final']);
  assert.equal(doneEvents[0].scorer, 'them');
});

test('two NC7 teams in one game keep separate event history', () => {
  const previous = new Map();
  const ncsuView = normalizeGame(ev({ id: 'g3', date: '2026-10-03T16:00Z', state: 'in', detail: '1st 2:00', us: 0, them: 0, usTeam: UNC, theirTeam: DUKE, venue: KENAN }), 'football', 'unc', espnToProgram);
  const dukeView = normalizeGame(ev({ id: 'g3', date: '2026-10-03T16:00Z', state: 'in', detail: '1st 2:00', us: 0, them: 0, usTeam: DUKE, theirTeam: UNC, usHome: false, venue: KENAN }), 'football', 'duke', espnToProgram);
  detectEvents([ncsuView, dukeView], previous);
  const scored = normalizeGame(ev({ id: 'g3', date: '2026-10-03T16:00Z', state: 'in', detail: '1st 5:00', us: 7, them: 0, usTeam: UNC, theirTeam: DUKE, venue: KENAN }), 'football', 'unc', espnToProgram);
  const dukeScored = normalizeGame(ev({ id: 'g3', date: '2026-10-03T16:00Z', state: 'in', detail: '1st 5:00', us: 0, them: 7, usTeam: DUKE, theirTeam: UNC, usHome: false, venue: KENAN }), 'football', 'duke', espnToProgram);
  const events = detectEvents([scored, dukeScored], previous);
  assert.equal(events.filter((e) => e.programId === 'unc').length, 1);
  assert.equal(events.filter((e) => e.programId === 'duke').length, 1, 'Duke still sees the score');
});

test('a live game beats an upcoming one for the same team, and no game means "none"', () => {
  const games = [
    { programId: 'unc', status: 'upcoming', start: '2026-10-03T23:00:00Z', sport: 'football' },
    { programId: 'unc', status: 'live', start: '2026-10-03T16:00:00Z', sport: 'football' },
  ];
  const today = teamToday(games, 'unc', '2026-10-03');
  assert.equal(teamState(today), 'live');
  assert.equal(teamState(teamToday([], 'duke', '2026-10-03')), 'none');
});

test('summary counts teams by location and status for the day', () => {
  const teams = [
    { todayGames: [{ isHome: true, status: 'live' }] },
    { todayGames: [{ isHome: false, status: 'upcoming' }] },
    { todayGames: [{ isHome: false, status: 'final' }] },
    { todayGames: [] },
  ];
  const s = summarize(teams, new Date('2026-10-03T18:00:00Z'));
  assert.equal(s.teams, 4);
  assert.equal(s.playingToday, 3);
  assert.equal(s.home, 1);
  assert.equal(s.away, 2);
  assert.equal(s.live, 1);
  assert.equal(s.upcoming, 1);
  assert.equal(s.final, 1);
});

// ---------- endpoint with a fake ESPN ----------

let espn, server, base;
const tmp = null;

function scheduleFor(id) {
  if (id !== '153') return { events: [] };
  return { events: [
    ev({ id: 'live-unc', date: '2026-10-03T16:00Z', state: 'post', detail: 'Final', us: 26, them: 37, usTeam: UNC, theirTeam: { id: '87', displayName: 'Notre Dame Fighting Irish', shortDisplayName: 'Notre Dame', abbreviation: 'ND' }, venue: KENAN }),
    ev({ id: 'away-duke', date: '2026-10-17T16:00Z', state: 'pre', detail: '10/17 - 12:00 PM EDT', usTeam: UNC, theirTeam: DUKE, usHome: false, venue: WALLACE }),
  ] };
}

before(async () => {
  testDb = await createTestDatabase();
  espn = http.createServer((req, res) => {
    const json = (body) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    const m = req.url.match(/\/teams\/(\d+)\/schedule/);
    if (m) return json(scheduleFor(m[1]));
    if (req.url.includes('/football/college-football/scoreboard')) {
      // The live board has a score the schedule doesn't, to check that the board wins.
      return json({ events: [ev({ id: 'live-unc', date: '2026-10-03T16:00Z', state: 'in', detail: '3rd 4:32', period: 3, clock: '4:32', us: 31, them: 24, usTeam: UNC, theirTeam: { id: '87', displayName: 'Notre Dame Fighting Irish', shortDisplayName: 'Notre Dame', abbreviation: 'ND' }, venue: KENAN })] });
    }
    json({ events: [] });
  });
  await new Promise((r) => espn.listen(0, '127.0.0.1', r));
  const port = 4600 + Math.floor(Math.random() * 300);
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

test('/api/nc7 returns all seven programs with live scores taken from the scoreboard', async () => {
  const res = await fetch(base + '/api/nc7');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('cache-control'), /no-store/);
  const data = await res.json();
  const football = data.sports.football;
  assert.equal(football.teams.length, 7);
  const unc = football.teams.find((t) => t.programId === 'unc');
  assert.equal(unc.currentGame.status, 'live');
  assert.deepEqual(unc.currentGame.score, { us: 31, them: 24 }, 'scoreboard score overrides the schedule');
  assert.equal(unc.currentGame.statusText, '3rd 4:32');
});

test('away games carry venue coordinates and a home base for the route', async () => {
  const data = await (await fetch(base + '/api/nc7')).json();
  const unc = data.sports.football.teams.find((t) => t.programId === 'unc');
  assert.equal(unc.homeVenue.name, 'Kenan Stadium');
  assert.ok(unc.homeVenue.coords, 'home venue is geocoded');
  const away = unc.games.find((g) => g.id === 'away-duke');
  assert.equal(away.isHome, false);
  assert.ok(away.venueCoords, 'Wallace Wade Stadium is geocoded');
  assert.equal(away.venue.name, 'Wallace Wade Stadium');
});

test('teams with no game today report "none", and the summary counts match', async () => {
  const data = await (await fetch(base + '/api/nc7')).json();
  const ecu = data.sports.football.teams.find((t) => t.programId === 'ecu');
  assert.equal(ecu.state, 'none');
  assert.equal(data.sports.football.summary.teams, 7);
  assert.equal(data.sports.football.summary.live, 1);
});

test('the weekend window and the feed timestamp are included', async () => {
  const data = await (await fetch(base + '/api/nc7')).json();
  assert.ok(data.window.start <= data.window.end);
  assert.ok(Date.parse(data.asOf) > 0);
});
