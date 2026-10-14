// NCSR Live Map: the seven NC FBS programs' schedules, live scores and game events.
// Data comes from ESPN's public team schedule and scoreboard feeds. Nothing is invented: if a feed
// is down, the affected games are left out and the response says so.

import fs from 'node:fs';

import { dataFile } from './paths.js';

const VENUES = JSON.parse(fs.readFileSync(dataFile('venues.json'), 'utf8')).venues;

const ESPN = process.env.ESPN_API_BASE || 'https://site.api.espn.com/apis/site/v2/sports';
const SCHEDULE_TTL_MS = 2 * 60 * 1000;
const BOARD_TTL_MS = 15 * 1000;
const UNRANKED = 99;
const SPORTS = {
  football: { path: 'football/college-football', groups: 80 },
  'mens-basketball': { path: 'basketball/mens-college-basketball', groups: 50 },
};

// ---------- dates (America/New_York, the way ESPN and fans count game days) ----------

export function etDate(now = new Date()) {
  return now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function addDays(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// "This weekend": Friday through Sunday. On a weekend day, that's the current weekend.
export function weekendWindow(now = new Date()) {
  const today = etDate(now);
  const dow = new Date(`${today}T12:00:00Z`).getUTCDay(); // 0 Sun ... 6 Sat
  const toFriday = dow === 5 ? 0 : dow === 6 ? -1 : dow === 0 ? -2 : (5 - dow + 7) % 7;
  const start = addDays(today, toFriday);
  return { start, end: addDays(start, 2) };
}

// ---------- geography ----------

export function haversineMiles(a, b) {
  const R = 3958.8;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

function venueKey(v) {
  return `${v.name}|${v.city || ''}|${v.state || ''}`;
}

function coordsFor(v) {
  const hit = v && VENUES[venueKey(v)];
  return hit && hit.lat !== null && hit.lat !== undefined ? { lat: hit.lat, lng: hit.lng, approximate: Boolean(hit.approximate) } : null;
}

// ---------- game normalization ----------

const ranked = (value) => (value && value < UNRANKED ? value : null);
const num = (x) => {
  const n = typeof x === 'object' && x !== null ? Number(x.value ?? x.displayValue) : Number(x);
  return Number.isFinite(n) ? n : null;
};

export function statusKind(status) {
  const name = status?.type?.name || '';
  if (/POSTPONED|CANCEL|SUSPENDED/.test(name)) return 'postponed';
  const state = status?.type?.state;
  if (state === 'in') return 'live';
  if (state === 'post') return 'final';
  return 'upcoming';
}

// Builds one game from a team's perspective. `competitions[0]` holds the score and venue.
export function normalizeGame(event, sport, programId, espnToProgram) {
  const c = event.competitions[0];
  const me = c.competitors.find((x) => programId && String(x.team.id) === espnIdOf(programId, espnToProgram));
  const opp = c.competitors.find((x) => x !== me) || c.competitors[1];
  const venue = c.venue ? {
    name: c.venue.fullName,
    city: c.venue.address?.city ?? null,
    state: c.venue.address?.state ?? null,
  } : null;
  const opponentProgram = espnToProgram.get(String(opp.team.id)) || null;
  return {
    id: String(event.id),
    sport,
    programId,
    start: event.date,
    isHome: me.homeAway === 'home',
    status: statusKind(c.status),
    statusText: c.status?.type?.shortDetail || '',
    period: c.status?.period ?? null,
    clock: c.status?.displayClock ?? null,
    score: { us: num(me.score), them: num(opp.score) },
    venue,
    venueCoords: coordsFor(venue),
    opponent: {
      espnId: String(opp.team.id),
      programId: opponentProgram ? opponentProgram.id : null,
      name: opp.team.shortDisplayName || opp.team.displayName,
      abbr: opp.team.abbreviation,
      logo: opp.team.logo || null,
      rank: ranked(opp.curatedRank?.current),
      record: opp.records?.[0]?.summary ?? null,
    },
    usRank: ranked(me.curatedRank?.current),
    usRecord: me.records?.[0]?.summary ?? null,
  };
}

function espnIdOf(programId, espnToProgram) {
  for (const [espnId, p] of espnToProgram) if (p.id === programId) return espnId;
  return null;
}

// Labels a change in score. Football field goals are 3 points; touchdowns are 6 to 8 (with the point after).
export function scoreLabel(delta, sport) {
  if (sport !== 'football') return 'Score';
  if (delta === 3) return 'Field goal';
  if (delta >= 6 && delta <= 8) return 'Touchdown';
  return 'Score';
}

// A game appears once per NC7 team in it. Each team's view keeps its own history.
function perspectiveKey(g) {
  return `${g.sport}|${g.programId}|${g.id}`;
}

// Compares this snapshot with the last one and returns new events (score changes, halftime, final).
export function detectEvents(games, previous, now = new Date()) {
  const events = [];
  for (const g of games) {
    const key = perspectiveKey(g);
    const before = previous.get(key);
    const at = now.toISOString();
    if (before) {
      const us = g.score.us ?? 0;
      const them = g.score.them ?? 0;
      const bUs = before.score.us ?? 0;
      const bThem = before.score.them ?? 0;
      const delta = (us - bUs) + (them - bThem);
      if (delta > 0 && (us > bUs || them > bThem)) {
        const scorer = us > bUs ? 'us' : 'them';
        const pts = scorer === 'us' ? us - bUs : them - bThem;
        events.push({ gameId: g.id, programId: g.programId, sport: g.sport, type: scoreLabel(pts, g.sport), scorer, at });
      }
      if (/half/i.test(g.statusText) && !/half/i.test(before.statusText)) events.push({ gameId: g.id, programId: g.programId, sport: g.sport, type: 'Halftime', at });
      if (g.status === 'final' && before.status !== 'final') events.push({ gameId: g.id, programId: g.programId, sport: g.sport, type: 'Final', at });
    }
    previous.set(key, { score: g.score, statusText: g.statusText, status: g.status });
  }
  return events;
}

// ---------- team status for the day ----------

const RANK_ORDER = { live: 0, upcoming: 1, final: 2, postponed: 3 };

export function teamToday(games, programId, today) {
  const mine = games.filter((g) => g.programId === programId && (g.status === 'live' || etDate(new Date(g.start)) === today));
  mine.sort((a, b) => RANK_ORDER[a.status] - RANK_ORDER[b.status] || new Date(a.start) - new Date(b.start));
  return mine;
}

export function teamState(todayGames) {
  if (!todayGames.length) return 'none';
  return todayGames[0].status === 'postponed' ? 'none' : todayGames[0].status;
}

export function summarize(teams, now = new Date()) {
  const today = etDate(now);
  const counts = { teams: teams.length, playingToday: 0, home: 0, away: 0, live: 0, upcoming: 0, final: 0 };
  for (const t of teams) {
    const g = t.todayGames[0];
    if (!g) continue;
    counts.playingToday += 1;
    counts[g.isHome ? 'home' : 'away'] += 1;
    if (g.status === 'live' || g.status === 'upcoming' || g.status === 'final') counts[g.status] += 1;
  }
  return { date: today, ...counts };
}

// ---------- building the view ----------

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'NorthCarolinaSportsReport/1.0' } });
  if (!res.ok) throw new Error(`ESPN responded ${res.status}`);
  return res.json();
}

const scheduleCache = new Map();
const boardCache = new Map();

async function schedules(programs) {
  const now = Date.now();
  const out = {};
  for (const [sport, s] of Object.entries(SPORTS)) {
    out[sport] = {};
    await Promise.all(programs.map(async (p) => {
      const key = `${sport}:${p.espnId}`;
      const hit = scheduleCache.get(key);
      if (hit && now - hit.at < SCHEDULE_TTL_MS) return (out[sport][p.id] = hit.events);
      try {
        const data = await getJson(`${ESPN}/${s.path}/teams/${p.espnId}/schedule`);
        scheduleCache.set(key, { at: now, events: data.events || [] });
        out[sport][p.id] = data.events || [];
      } catch {
        out[sport][p.id] = hit ? hit.events : null; // keep the last good copy, or mark as unavailable
      }
    }));
  }
  return out;
}

async function boards(date) {
  const out = {};
  for (const [sport, s] of Object.entries(SPORTS)) {
    const key = `${sport}:${date}`;
    const hit = boardCache.get(key);
    if (hit && Date.now() - hit.at < BOARD_TTL_MS) { out[sport] = hit.events; continue; }
    try {
      const data = await getJson(`${ESPN}/${s.path}/scoreboard?groups=${s.groups}&dates=${date.replace(/-/g, '')}&limit=300`);
      boardCache.set(key, { at: Date.now(), events: data.events || [] });
      out[sport] = data.events || [];
    } catch {
      out[sport] = hit ? hit.events : [];
    }
  }
  return out;
}

const previousSnapshot = new Map();
const recentEvents = [];

// Builds everything the map needs. `programs` comes from the central team list in content.json.
export async function buildNc7(programs, now = new Date()) {
  const today = etDate(now);
  const espnToProgram = new Map(programs.map((p) => [String(p.espnId), p]));
  const [sched, board] = await Promise.all([schedules(programs), boards(today)]);

  const games = [];
  const unavailable = [];
  const sports = {};

  for (const sport of Object.keys(SPORTS)) {
    const sportGames = [];
    for (const p of programs) {
      const events = sched[sport][p.id];
      if (events === null) { unavailable.push({ programId: p.id, sport }); continue; }
      for (const ev of events) sportGames.push(normalizeGame(ev, sport, p.id, espnToProgram));
    }
    // Live boards are fresher than schedules: take the score and status from the scoreboard when it has the game.
    const liveById = new Map((board[sport] || []).map((e) => [String(e.id), e]));
    for (const g of sportGames) {
      const fresh = liveById.get(g.id);
      if (!fresh) continue;
      const fresherGame = normalizeGame(fresh, sport, g.programId, espnToProgram);
      Object.assign(g, { status: fresherGame.status, statusText: fresherGame.statusText, period: fresherGame.period, clock: fresherGame.clock, score: fresherGame.score });
    }
    games.push(...sportGames);
  }

  const events = detectEvents(games, previousSnapshot, now);
  for (const e of events) recentEvents.unshift(e);
  recentEvents.splice(50);

  for (const sport of Object.keys(SPORTS)) {
    const sportGames = games.filter((g) => g.sport === sport);
    const teams = programs.map((p) => {
      const mine = sportGames.filter((g) => g.programId === p.id);
      const todayGames = teamToday(sportGames, p.id, today);
      const homes = mine.filter((g) => g.isHome && g.venue).map((g) => g.venue);
      const homeVenue = mostCommonVenue(homes);
      const upcoming = mine.filter((g) => g.status === 'upcoming').sort((a, b) => new Date(a.start) - new Date(b.start));
      const finals = mine.filter((g) => g.status === 'final').sort((a, b) => new Date(b.start) - new Date(a.start));
      return {
        programId: p.id,
        name: p.name,
        nickname: p.nickname,
        short: p.short,
        color: p.color,
        record: p.sports?.[sport]?.record ?? null,
        recordAsOf: p.sports?.[sport]?.asOf ?? null,
        homeVenue: homeVenue ? { ...homeVenue, coords: coordsFor(homeVenue) } : null,
        state: teamState(todayGames),
        todayGames,
        currentGame: todayGames[0] || null,
        nextGame: upcoming[0] || null,
        lastGame: finals[0] || null,
        games: mine.sort((a, b) => new Date(a.start) - new Date(b.start)),
        feedComplete: !unavailable.some((u) => u.programId === p.id && u.sport === sport),
      };
    });
    sports[sport] = { teams, summary: summarize(teams, now) };
  }

  return {
    asOf: now.toISOString(),
    date: today,
    window: weekendWindow(now),
    sports,
    games,
    events: recentEvents.filter((e) => Date.now() - new Date(e.at).getTime() < 90 * 1000),
    unavailable,
  };
}

function mostCommonVenue(venues) {
  const counts = new Map();
  for (const v of venues) {
    const key = venueKey(v);
    counts.set(key, { count: (counts.get(key)?.count || 0) + 1, venue: v });
  }
  let best = null;
  for (const entry of counts.values()) if (!best || entry.count > best.count) best = entry;
  return best ? best.venue : null;
}

// Resets the in-memory caches (used by tests).
export function resetNc7Caches() {
  scheduleCache.clear();
  boardCache.clear();
  previousSnapshot.clear();
  recentEvents.length = 0;
}
