// Pro Sports: Carolina Panthers (NFL), Charlotte Hornets (NBA), Carolina Hurricanes (NHL).
//
// Everything here is real, sourced data from ESPN's public feeds: team records, schedules,
// live scores, league standings, and news. NC Sports Report has no newsroom of its own yet, so
// this module does not write original articles or invent storylines, quotes or stats. Instead it
// pulls ESPN's own reporting, picks the stories that are actually about one of these three teams
// (not generic league round-ups), and links back to the full story on ESPN with clear attribution.
// That is a deliberate, disclosed choice — see README.md.

import { dataFile } from './paths.js';

const ESPN = process.env.ESPN_API_BASE || 'https://site.api.espn.com/apis/site/v2/sports';
const ESPN_WEB = process.env.ESPN_WEB_API_BASE || 'https://site.web.api.espn.com/apis/v2/sports';
const SCHEDULE_TTL_MS = 5 * 60 * 1000;
const BOARD_TTL_MS = 20 * 1000;
const STANDINGS_TTL_MS = 15 * 60 * 1000;
const NEWS_TTL_MS = 5 * 60 * 1000;

// One central place for the three teams this section covers. Add a team here and the rest of the
// module (schedule, standings, news, score formatting) follows automatically.
export const PRO_TEAMS = {
  panthers: {
    key: 'panthers', espnId: 29, sport: 'football', league: 'nfl', leagueLabel: 'NFL',
    sportPath: 'football/nfl', name: 'Carolina Panthers', nickname: 'Panthers', short: 'Panthers',
    city: 'Carolina', color: '#0085CA', colorDark: '#101820', colorAlt: '#BFC0BF',
    scoreNoun: 'points', periodNoun: 'quarter', kickoffNoun: 'Kickoff',
  },
  hornets: {
    key: 'hornets', espnId: 30, sport: 'basketball', league: 'nba', leagueLabel: 'NBA',
    sportPath: 'basketball/nba', name: 'Charlotte Hornets', nickname: 'Hornets', short: 'Hornets',
    city: 'Charlotte', color: '#1D1160', colorDark: '#00778B', colorAlt: '#A1A1A4',
    scoreNoun: 'points', periodNoun: 'quarter', kickoffNoun: 'Tip-off',
  },
  hurricanes: {
    key: 'hurricanes', espnId: 7, sport: 'hockey', league: 'nhl', leagueLabel: 'NHL',
    sportPath: 'hockey/nhl', name: 'Carolina Hurricanes', nickname: 'Hurricanes', short: 'Hurricanes',
    city: 'Carolina', color: '#C8102E', colorDark: '#000000', colorAlt: '#A2AAAD',
    scoreNoun: 'goals', periodNoun: 'period', kickoffNoun: 'Puck drop',
  },
};
export const TEAM_KEYS = Object.keys(PRO_TEAMS);

// What each league's standings table shows. ESPN already formats W-L-T / W-L / W-L-OTL correctly
// per sport, so the dashboard and standings table just display the fields a sport actually uses
// instead of forcing one shape onto all three.
const STANDINGS_COLUMNS = {
  nfl: [['overall', 'W-L-T'], ['winPercent', 'PCT'], ['gamesBehind', 'GB'], ['streak', 'STRK']],
  nba: [['overall', 'W-L'], ['winPercent', 'PCT'], ['gamesBehind', 'GB'], ['streak', 'STRK']],
  nhl: [['overall', 'W-L-OTL'], ['points', 'PTS'], ['gamesBehind', 'GB'], ['streak', 'STRK']],
};
export { STANDINGS_COLUMNS };

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'NorthCarolinaSportsReport/1.0' } });
  if (!res.ok) throw new Error(`ESPN responded ${res.status} for ${url}`);
  return res.json();
}

// ---------- pure helpers (exported for tests) ----------

export function statusKind(status) {
  const name = status?.type?.name || '';
  if (/POSTPONED|CANCEL|SUSPENDED|DELAY/.test(name)) return 'postponed';
  const state = status?.type?.state;
  if (state === 'in') return 'live';
  if (state === 'post') return 'final';
  return 'upcoming';
}

// Normalizes one ESPN schedule/scoreboard event from this team's point of view.
export function normalizeGame(event, team) {
  const c = event.competitions[0];
  const me = c.competitors.find((x) => String(x.team.id) === String(team.espnId));
  const opp = c.competitors.find((x) => x !== me) || c.competitors[1];
  if (!me || !opp) return null;
  const recapHeadline = (c.headlines || []).find((h) => h.type === 'Recap');
  const linkByRel = (rel) => (event.links || []).find((l) => l.rel?.includes(rel))?.href ?? null;
  return {
    id: String(event.id),
    team: team.key,
    date: event.date,
    isHome: me.homeAway === 'home',
    status: statusKind(c.status),
    statusText: c.status?.type?.shortDetail || '',
    period: c.status?.period ?? null,
    clock: c.status?.displayClock ?? null,
    score: {
      us: me.score != null ? Number(me.score?.value ?? me.score) : null,
      them: opp.score != null ? Number(opp.score?.value ?? opp.score) : null,
    },
    venue: c.venue ? { name: c.venue.fullName, city: c.venue.address?.city ?? null, state: c.venue.address?.state ?? null } : null,
    opponent: {
      name: opp.team.shortDisplayName || opp.team.displayName,
      abbr: opp.team.abbreviation,
      logo: opp.team.logo || null,
      record: opp.records?.[0]?.summary ?? null,
    },
    usRecord: me.records?.[0]?.summary ?? null,
    // ESPN's own recap text and links, not our writing. The gamecast link always works; the others
    // only exist once ESPN has published that stage of coverage.
    recap: recapHeadline ? { text: recapHeadline.description, source: 'ESPN' } : null,
    links: {
      gamecast: linkByRel('gamecast'),
      recap: linkByRel('recap'),
      preview: linkByRel('preview'),
      boxscore: linkByRel('boxscore'),
    },
    leaders: (c.leaders || []).map((cat) => {
      const top = cat.leaders?.[0];
      return top ? { category: cat.displayName, athlete: top.athlete?.displayName, line: top.displayValue } : null;
    }).filter(Boolean),
  };
}

function pickNextAndLast(games) {
  const upcoming = games.filter((g) => g.status === 'upcoming').sort((a, b) => new Date(a.date) - new Date(b.date));
  const live = games.filter((g) => g.status === 'live');
  const finals = games.filter((g) => g.status === 'final').sort((a, b) => new Date(b.date) - new Date(a.date));
  return { next: upcoming[0] || null, last: finals[0] || null, live: live[0] || null, upcoming, finals };
}

// Ranks ESPN's news feed by how specific a story is to one team: an article tagged with two teams
// (a game story) ranks far above a 32-team round-up. Articles about other teams only are dropped.
export function rankArticles(articles, team, limit = 12) {
  const scored = [];
  for (const a of articles) {
    const teamTags = (a.categories || []).filter((c) => c.type === 'team');
    const teamIds = teamTags.map((c) => c.teamId);
    if (!teamIds.includes(team.espnId)) continue;
    const specificity = teamIds.length;
    scored.push({ article: a, specificity });
  }
  scored.sort((x, y) => x.specificity - y.specificity || new Date(y.article.published) - new Date(x.article.published));
  return scored.slice(0, limit).map(({ article, specificity }) => ({
    id: String(article.id ?? article.dataSourceIdentifier ?? article.links?.web?.href),
    headline: article.headline,
    description: article.description || null,
    published: article.published,
    url: article.links?.web?.href || null,
    image: (article.images || [])[0]?.url || null,
    imageCaption: (article.images || [])[0]?.caption || null,
    specific: specificity <= 3,
    // No newsroom flag exists yet to set this from, so it is always false; see breakingBanner() in pro-sports.js.
    breaking: false,
    category: classifyArticle(article, specificity),
    source: 'ESPN',
  }));
}

// A light heuristic, not a verified editorial category: picks the best-fit label from the
// headline and description so the filter chips have something real to group by.
export function classifyArticle(article, specificity) {
  const text = `${article.headline || ''} ${article.description || ''}`.toLowerCase();
  // Order matters: a more specific signal (injury, a trade) should win even if the headline
  // also happens to contain a scheduling word like "vs." or "preview".
  if (/\b(questionable|doubtful|injur|\bir\b|injured reserve|out for|likely out|sidelined|day-to-day|shoulder|hamstring|concussion|no-contact)\b/.test(text)) return 'Injury Update';
  if (/\b(trade|traded|sign|signs|signed|waive|waived|release|released|claim|claimed|activate|promote|re-sign)\b/.test(text)) return 'Transactions';
  if (/\b(mock draft|draft order|draft pick|prospect)\b/.test(text)) return 'Draft';
  if (specificity <= 2 && /\b(beat|beats|defeat|defeats|fall to|falls to|top|tops|rout|edge|edges|win over|lead|lift|rally|hat trick)\b/.test(text)) return 'Game Recap';
  if (specificity <= 3 && /\b(preview|vs\.|how to watch|odds|prediction|matchup)\b/.test(text)) return 'Game Preview';
  if (/\b(power rankings|bpi|projections|odds to win|analytics|film room)\b/.test(text)) return 'Analysis';
  if (specificity <= 2) return 'Team News';
  return 'League News';
}

// ---------- fetchers with simple in-memory caches ----------

const scheduleCache = new Map();
const boardCache = new Map();
const standingsCache = new Map();
const newsCache = new Map();
const teamInfoCache = new Map();

async function cached(cache, key, ttl, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  try {
    const value = await fn();
    cache.set(key, { at: Date.now(), value });
    return value;
  } catch (err) {
    if (hit) return hit.value; // serve the last good copy rather than breaking the page
    throw err;
  }
}

async function fetchTeamInfo(team) {
  return cached(teamInfoCache, team.key, SCHEDULE_TTL_MS, async () => {
    const d = await getJson(`${ESPN}/${team.sportPath}/teams/${team.espnId}`);
    const t = d.team || {};
    return {
      record: t.record?.items?.find((r) => r.type === 'total')?.summary ?? null,
      standingSummary: t.standingSummary ?? null,
      logo: (t.logos || [])[0]?.href ?? null,
      venue: t.venue ? { name: t.venue.fullName, city: t.venue.address?.city ?? null, state: t.venue.address?.state ?? null } : null,
    };
  });
}

async function fetchSchedule(team) {
  const events = await cached(scheduleCache, team.key, SCHEDULE_TTL_MS, async () => {
    const d = await getJson(`${ESPN}/${team.sportPath}/teams/${team.espnId}/schedule`);
    return d.events || [];
  });
  return events.map((e) => normalizeGame(e, team)).filter(Boolean);
}

async function fetchBoard(team, date) {
  const key = `${team.key}:${date}`;
  const events = await cached(boardCache, key, BOARD_TTL_MS, async () => {
    const d = await getJson(`${ESPN}/${team.sportPath}/scoreboard?dates=${date.replace(/-/g, '')}&limit=300`);
    return d.events || [];
  });
  const mine = events.filter((e) => e.competitions[0].competitors.some((c) => String(c.team.id) === String(team.espnId)));
  return mine.map((e) => normalizeGame(e, team)).filter(Boolean);
}

async function fetchStandings(league, sportPath) {
  return cached(standingsCache, league, STANDINGS_TTL_MS, async () => {
    const d = await getJson(`${ESPN_WEB}/${sportPath}/standings`);
    const conferences = (d.children || []).map((conf) => ({
      name: conf.name,
      entries: (conf.standings?.entries || []).map((e) => ({
        teamId: Number(e.team.id),
        name: e.team.displayName,
        abbr: e.team.abbreviation,
        logo: (e.team.logos || [])[0]?.href ?? null,
        stats: Object.fromEntries((e.stats || []).map((s) => [s.name, s.displayValue])),
      })),
    }));
    return { conferences, season: d.season?.year ?? null };
  });
}

async function fetchNews(team) {
  return cached(newsCache, team.key, NEWS_TTL_MS, async () => {
    const d = await getJson(`${ESPN}/${team.sportPath}/news?team=${team.espnId}&limit=30`);
    return d.articles || [];
  });
}

// ---------- assembling the view the front end uses ----------

function easternDate(now = new Date()) {
  return now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

export async function buildTeam(key, now = new Date()) {
  const team = PRO_TEAMS[key];
  if (!team) throw new Error(`Unknown team: ${key}`);
  const date = easternDate(now);
  const [info, schedule, board, articles] = await Promise.all([
    fetchTeamInfo(team).catch(() => null),
    fetchSchedule(team).catch(() => []),
    fetchBoard(team, date).catch(() => []),
    fetchNews(team).catch(() => []),
  ]);
  const boardById = new Map(board.map((g) => [g.id, g]));
  const games = schedule.map((g) => boardById.get(g.id) || g);
  const picks = pickNextAndLast(games);

  return {
    ...team,
    record: info?.record ?? null,
    standingSummary: info?.standingSummary ?? null,
    logo: info?.logo ?? null,
    homeVenue: info?.venue ?? null,
    games,
    next: picks.next,
    last: picks.last,
    live: picks.live,
    news: rankArticles(articles, team),
  };
}

export async function buildPro(now = new Date()) {
  const teams = {};
  await Promise.all(TEAM_KEYS.map(async (key) => { teams[key] = await buildTeam(key, now); }));

  const standings = {};
  const leaguePaths = {};
  for (const t of Object.values(PRO_TEAMS)) leaguePaths[t.league] = t.sportPath;
  await Promise.all(Object.entries(leaguePaths).map(async ([league, sportPath]) => {
    try {
      standings[league] = await fetchStandings(league, sportPath);
    } catch {
      standings[league] = null;
    }
  }));

  return { updatedAt: now.toISOString(), teams, standings };
}

export function resetProCaches() {
  for (const c of [scheduleCache, boardCache, standingsCache, newsCache, teamInfoCache]) c.clear();
}
